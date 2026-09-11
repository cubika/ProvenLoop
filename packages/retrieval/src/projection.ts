import {
  knowledgeCandidateSchema,
  type KnowledgeCandidate,
  type RuleProposal,
} from "@provenloop/contracts";
import { containsPotentialSecret, hasAcceptedLearningDistillation, sha256 } from "@provenloop/domain";

import type {
  CanonicalKnowledgeStore,
  KnowledgeBackend,
  KnowledgeProjection,
} from "./types.js";

export const knowledgeProjectionFromCandidate = (
  input: KnowledgeCandidate,
  proposals: readonly RuleProposal[] = [],
): KnowledgeProjection => {
  const candidate = knowledgeCandidateSchema.parse(input);
  const searchAliases = [...new Set(proposals.filter((proposal) =>
    proposal.knowledgeId === candidate.knowledgeId && proposal.rule === candidate.content &&
    sha256([proposal.trigger]) === sha256(candidate.appliesWhen) && sha256(proposal.exclusions) === sha256(candidate.nonApplicability) &&
    proposal.sourceDigests.length === candidate.sourceEvidenceIds.length &&
    proposal.sourceDigests.every((source) => candidate.sourceEvidenceIds.includes(source.eventId)) &&
    hasAcceptedLearningDistillation(proposal, proposal.sourceDigests) &&
    proposal.canonicalKey !== undefined && !containsPotentialSecret(proposal.canonicalKey),
  ).map((proposal) => proposal.canonicalKey as string))].sort();
  return {
    appliesWhen: candidate.appliesWhen,
    content: candidate.content,
    knowledgeId: candidate.knowledgeId,
    nonApplicability: candidate.nonApplicability,
    projectionVersion: 1,
    // Aliases affect discovery, so bind them to canonical state and recheck them on retrieval.
    sourceDigest: searchAliases.length ? sha256({ candidate, searchAliases }) : sha256(candidate),
    ...(searchAliases.length ? { searchAliases } : {}),
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
    const available = candidates.filter((candidate) => !deleted.has(candidate.knowledgeId));
    const proposalsById = new Map<string, RuleProposal[]>();
    for (const proposal of this.#store.learningProposals?.(available.map((candidate) => candidate.knowledgeId)) ?? []) {
      const entries = proposalsById.get(proposal.knowledgeId) ?? [];
      entries.push(proposal); proposalsById.set(proposal.knowledgeId, entries);
    }
    const records = available.map((candidate) => knowledgeProjectionFromCandidate(candidate, proposalsById.get(candidate.knowledgeId)));
    await this.#backend.rebuild({
      records,
    });
    return records.length;
  }
}
