import type {
  KnowledgeCandidate,
} from "@provenloop/contracts";
import {
  KnowledgeAdmissionPolicy,
  sha256,
} from "@provenloop/domain";

import {
  AUTOMATIC_RETRIEVAL_EVIDENCE_TIERS,
  scopeMatches,
  type CanonicalKnowledgeAdmissionStore,
  type KnowledgeBackend,
  type KnowledgeRetrievalQuery,
  type RetrievedKnowledge,
} from "./types.js";

const eligible = (
  candidate: KnowledgeCandidate,
  query: KnowledgeRetrievalQuery,
  now: Date,
): boolean =>
  candidate.state === "active" &&
  AUTOMATIC_RETRIEVAL_EVIDENCE_TIERS.has(
    candidate.evidenceTier,
  ) &&
  (
    candidate.expiresAt === undefined ||
    Date.parse(candidate.expiresAt) > now.getTime()
  ) &&
  scopeMatches(candidate.scope, candidate.scopeId, query);

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
          !eligible(candidate, query, now) ||
          admissionById.get(candidate.knowledgeId)?.admitted !== true ||
          hit.sourceDigest !== sha256(candidate)
        ) {
          continue;
        }
        retrieved.push({
          candidate,
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
