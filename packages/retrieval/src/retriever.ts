import type {
  KnowledgeCandidate,
} from "@provenloop/contracts";
import {
  KnowledgeAdmissionPolicy,
  sha256,
  learningSourceUse,
  type LearningSourceUse,
} from "@provenloop/domain";
import { posix, win32 } from "node:path";

import {
  AUTOMATIC_RETRIEVAL_EVIDENCE_TIERS,
  scopeMatches,
  type CanonicalKnowledgeAdmissionStore,
  type KnowledgeBackend,
  type KnowledgeRetrievalQuery,
  type RetrievedKnowledge,
} from "./types.js";
import { learningApplicable } from "./learning-applicability.js";

const eligible = (
  candidate: KnowledgeCandidate,
  query: KnowledgeRetrievalQuery,
  now: Date,
  sourceUse?: LearningSourceUse,
): boolean =>
  ((candidate.state === "candidate" && sourceUse !== undefined) || (candidate.state === "active" &&
  AUTOMATIC_RETRIEVAL_EVIDENCE_TIERS.has(
    candidate.evidenceTier,
  ))) &&
  (
    candidate.expiresAt === undefined ||
    Date.parse(candidate.expiresAt) > now.getTime()
  ) &&
  scopeMatches(candidate.scope, candidate.scopeId, query);

const sameWorktree = (left: string, right: string): boolean => {
  const windows = /^[a-z]:[\\/]|^[\\/]{2}/iu.test(left);
  const normalize = (path: string): string => windows
    ? win32.normalize(path).replace(/[\\/]+$/u, "").toLowerCase()
    : posix.normalize(path).replace(/\/+$/u, "");
  const root = normalize(left);
  const target = normalize(right);
  const api = windows ? win32 : posix;
  if (!api.isAbsolute(right)) return false;
  const relative = api.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${api.sep}`) && relative !== ".." && !api.isAbsolute(relative));
};

export class CanonicalKnowledgeRetriever {
  readonly #admissionPolicy: KnowledgeAdmissionPolicy;
  readonly #backend: KnowledgeBackend;
  readonly #store: CanonicalKnowledgeAdmissionStore;

  public constructor(options: {
    readonly admissionPolicy?: KnowledgeAdmissionPolicy;
    readonly backend: KnowledgeBackend;
    readonly store: CanonicalKnowledgeAdmissionStore;
  }) {
    this.#admissionPolicy =
      options.admissionPolicy ?? new KnowledgeAdmissionPolicy();
    this.#backend = options.backend;
    this.#store = options.store;
  }

  public async search(
    query: KnowledgeRetrievalQuery,
    options: {
      readonly timeoutMs?: number;
    } = {},
  ): Promise<readonly RetrievedKnowledge[]> {
    if (!Number.isInteger(query.limit) || query.limit <= 0) {
      throw new RangeError("Knowledge retrieval limit must be positive.");
    }
    if (
      options.timeoutMs !== undefined &&
      (
        !Number.isInteger(options.timeoutMs) ||
        options.timeoutMs <= 0
      )
    ) {
      throw new RangeError(
        "Knowledge retrieval timeout must be positive.",
      );
    }
    const now = query.now ?? new Date();
    const pageSize = Math.max(query.limit * 5, 20);
    const retrieved: RetrievedKnowledge[] = [];
    const admissionById = new Map<
      string,
      ReturnType<KnowledgeAdmissionPolicy["evaluate"]>
    >();
    const applicableById = new Map<string, boolean>();
    const sourceUseById = new Map<string, LearningSourceUse>();
    const learningApplicabilityById = new Map<string, readonly string[]>();
    const deadline =
      options.timeoutMs === undefined
        ? undefined
        : Date.now() + options.timeoutMs;
    let offset = 0;
    while (retrieved.length < query.limit) {
      if (
        deadline !== undefined &&
        Date.now() >= deadline
      ) {
        throw new Error("Knowledge retrieval timed out.");
      }
      const backendQuery = {
        limit: pageSize,
        ...(query.match === undefined ? {} : { match: query.match }),
        offset,
        text: query.text,
      };
      const remaining =
        deadline === undefined
          ? undefined
          : deadline - Date.now();
      if (remaining !== undefined && remaining <= 0) {
        throw new Error("Knowledge retrieval timed out.");
      }
      const hits =
        remaining !== undefined &&
        this.#backend.searchWithTimeout !== undefined
          ? await this.#backend.searchWithTimeout(
              backendQuery,
              remaining,
            )
          : await this.#backend.search(backendQuery);
      if (hits.length === 0) {
        break;
      }
      const candidates = this.#store.knowledgeCandidates(
        hits.map((hit) => hit.knowledgeId),
      );
      const byId = new Map(
        candidates.map((candidate) => [
          candidate.knowledgeId,
          candidate,
        ]),
      );
      const deleted = this.#store
        .knowledgeCandidatesWithUnavailableSources(candidates);
      const unevaluatedCandidates = candidates.filter(
        (candidate) => !admissionById.has(candidate.knowledgeId),
      );
      if (unevaluatedCandidates.length > 0) {
        const evidence = this.#store.knowledgeAdmissionEvidence(
          unevaluatedCandidates,
        );
        for (const candidate of unevaluatedCandidates) {
          const sourceUse = learningSourceUse(candidate, evidence.learningProposals ?? [], evidence.envelopes, evidence.contextUseRecords);
          if (sourceUse) sourceUseById.set(candidate.knowledgeId, sourceUse);
          const sourceApplicable = sourceUse !== undefined && query.worktree !== undefined &&
            sameWorktree(sourceUse.worktree, query.worktree) &&
            !(query.projectInstructions ?? []).some((instruction) => {
              const normalize = (value: string) => value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
              const existing = normalize(instruction);
              return existing.includes(normalize(candidate.content)) || sourceUse.sources.some((source) => existing.includes(normalize(source.quote)));
            }) &&
            (sourceUse.mode !== "reference" || (query.headSha !== undefined && query.headSha === sourceUse.commitSha));
          applicableById.set(candidate.knowledgeId, sourceUse ? sourceApplicable : learningApplicable(
            candidate, evidence.learningProposals ?? [], query, evidence.learningReceipts ?? [],
          ));
          const proposal = evidence.learningProposals?.find((entry) =>
            entry.knowledgeId === candidate.knowledgeId && entry.predicate !== undefined &&
            entry.sourceDigests.length === candidate.sourceEvidenceIds.length &&
            entry.sourceDigests.every((source) => candidate.sourceEvidenceIds.includes(source.eventId)));
          if (proposal?.predicate) learningApplicabilityById.set(candidate.knowledgeId, [
            `Calling ${proposal.predicate.serverName}/${proposal.predicate.toolName} under its verified tool contract.`,
          ]);
        }
        for (const admission of this.#admissionPolicy.evaluateAll({
          candidates: unevaluatedCandidates,
          ...evidence,
        })) {
          admissionById.set(admission.knowledgeId, admission);
        }
      }
      if (
        deadline !== undefined &&
        Date.now() >= deadline
      ) {
        throw new Error("Knowledge retrieval timed out.");
      }
      for (const hit of hits) {
        const candidate = byId.get(hit.knowledgeId);
        if (
          candidate === undefined ||
          deleted.has(candidate.knowledgeId) ||
          !eligible(candidate, query, now, sourceUseById.get(candidate.knowledgeId)) ||
          applicableById.get(candidate.knowledgeId) !== true ||
          admissionById.get(candidate.knowledgeId)?.admitted !== true ||
          hit.sourceDigest !== sha256(candidate)
        ) {
          continue;
        }
        const sourceUse = sourceUseById.get(candidate.knowledgeId);
        retrieved.push({
          ...(sourceUse ? { deliveryMode: sourceUse.mode, sources: sourceUse.sources } : {}),
          candidate: learningApplicabilityById.has(candidate.knowledgeId)
            ? { ...candidate, appliesWhen: [...learningApplicabilityById.get(candidate.knowledgeId) ?? []] } : candidate,
          score: hit.score,
        });
        if (retrieved.length === query.limit) {
          break;
        }
      }
      offset += hits.length;
      if (hits.length < pageSize) {
        break;
      }
    }
    return retrieved;
  }
}
