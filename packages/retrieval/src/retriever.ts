import type {
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
  ): Promise<readonly RetrievedKnowledge[]> {
    if (!Number.isInteger(query.limit) || query.limit <= 0) {
      throw new RangeError("Knowledge retrieval limit must be positive.");
    }
    const now = query.now ?? new Date();
    const pageSize = Math.max(query.limit * 5, 20);
    const retrieved: RetrievedKnowledge[] = [];
    let offset = 0;
    while (retrieved.length < query.limit) {
      const hits = await this.#backend.search({
        limit: pageSize,
        offset,
        text: query.text,
      });
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
      for (const hit of hits) {
        const candidate = byId.get(hit.knowledgeId);
        if (
          candidate === undefined ||
          deleted.has(candidate.knowledgeId) ||
          !eligible(candidate, query, now) ||
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
