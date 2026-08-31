import {
  knowledgeCandidateSchema,
  type KnowledgeCandidate,
} from "@provenloop/contracts";
import { sha256 } from "@provenloop/domain";

import type {
  CanonicalKnowledgeStore,
  KnowledgeBackend,
  KnowledgeProjection,
} from "./types.js";

export const knowledgeProjectionFromCandidate = (
  input: KnowledgeCandidate,
): KnowledgeProjection => {
  const candidate = knowledgeCandidateSchema.parse(input);
  return {
    appliesWhen: candidate.appliesWhen,
    content: candidate.content,
    knowledgeId: candidate.knowledgeId,
    nonApplicability: candidate.nonApplicability,
    projectionVersion: 1,
    sourceDigest: sha256(candidate),
    topicKey: candidate.topicKey,
  };
};

export class KnowledgeProjectionManager {
  readonly #backend: KnowledgeBackend;
  readonly #store: CanonicalKnowledgeStore;

  public constructor(options: {
    readonly backend: KnowledgeBackend;
    readonly store: CanonicalKnowledgeStore;
  }) {
    this.#backend = options.backend;
    this.#store = options.store;
  }

  public async rebuild(): Promise<number> {
    const candidates = this.#store.knowledgeCandidates();
    const deleted = this.#store
      .knowledgeCandidatesWithUnavailableSources(candidates);
    const records = candidates
      .filter((candidate) => !deleted.has(candidate.knowledgeId))
      .map(knowledgeProjectionFromCandidate);
    await this.#backend.rebuild({
      records,
    });
    return records.length;
  }
}
