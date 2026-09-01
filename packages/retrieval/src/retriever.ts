import type {
  CorrectionKey,
  KnowledgeCandidate,
} from "@provenloop/contracts";
import { sha256 } from "@provenloop/domain";

import {
  AUTOMATIC_RETRIEVAL_EVIDENCE_TIERS,
  scopeMatches,
  type CanonicalKnowledgeStore,
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

const hasVerifiedCorrectionSources = (
  candidate: KnowledgeCandidate,
  correctionKeys: readonly CorrectionKey[],
  correctionSourceEventIds: ReadonlySet<string>,
): boolean => {
  const sourceEvidence = new Set(candidate.sourceEvidenceIds);
  const referencedCorrectionEventIds =
    candidate.sourceEvidenceIds.filter((eventId) =>
      correctionSourceEventIds.has(eventId),
    );
  if (referencedCorrectionEventIds.length === 0) {
    return true;
  }
  const referencedKeys = correctionKeys.filter((key) =>
    key.sourceCorrectionEventIds.some((eventId) =>
      sourceEvidence.has(eventId),
    ),
  );
  const verifiedSources = new Set(
    referencedKeys
      .filter((key) => key.verificationEvidenceIds.length > 0)
      .flatMap((key) => key.sourceCorrectionEventIds),
  );
  return referencedCorrectionEventIds.every(
    (eventId) => verifiedSources.has(eventId),
  );
};

export class CanonicalKnowledgeRetriever {
  readonly #backend: KnowledgeBackend;
  readonly #store: CanonicalKnowledgeStore;

  public constructor(options: {
    readonly backend: KnowledgeBackend;
    readonly store: CanonicalKnowledgeStore;
  }) {
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
      const correctionKeys = this.#store.correctionKeys();
      const correctionSourceEventIds =
        this.#store.correctionSourceEventIds();
      for (const hit of hits) {
        const candidate = byId.get(hit.knowledgeId);
        if (
          candidate === undefined ||
          deleted.has(candidate.knowledgeId) ||
          !eligible(candidate, query, now) ||
          !hasVerifiedCorrectionSources(
            candidate,
            correctionKeys,
            correctionSourceEventIds,
          ) ||
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
