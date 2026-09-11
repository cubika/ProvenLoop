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
  const reviewed = proposals.filter((proposal) =>
    proposal.knowledgeId === candidate.knowledgeId && proposal.rule === candidate.content &&
    sha256([proposal.trigger]) === sha256(candidate.appliesWhen) && sha256(proposal.exclusions) === sha256(candidate.nonApplicability) &&
    proposal.sourceDigests.length === candidate.sourceEvidenceIds.length &&
    proposal.sourceDigests.every((source) => candidate.sourceEvidenceIds.includes(source.eventId)) &&
    hasAcceptedLearningDistillation(proposal, proposal.sourceDigests),
  );
  const queryTerms = reviewed.flatMap((proposal) => {
    if (!proposal.queryTerms) return [];
    const normalize = (text: string): string => text.normalize("NFKC").toLowerCase();
    const quotes = [proposal.userSource?.quote, proposal.agentSource?.quote,
      ...(proposal.supportingSources ?? []).map((source) => source.quote),
      ...(proposal.agentSource?.evidenceSources ?? []).map((source) => source.quote),
    ].filter((quote): quote is string => quote !== undefined).map(normalize);
    return [...proposal.queryTerms.include, ...proposal.queryTerms.exclude].every((term) =>
      !containsPotentialSecret(term) && quotes.some((quote) => quote.includes(normalize(term))))
      ? [proposal.queryTerms] : [];
  });
  const searchAliases = [...new Set([
    ...reviewed.flatMap((proposal) => proposal.canonicalKey && !containsPotentialSecret(proposal.canonicalKey) ? [proposal.canonicalKey] : []),
    ...queryTerms.flatMap((terms) => terms.include),
  ])].sort();
  const searchExclusions = [...new Set(queryTerms.flatMap((terms) => terms.exclude))].sort();
  return {
    appliesWhen: candidate.appliesWhen,
    content: candidate.content,
    knowledgeId: candidate.knowledgeId,
    nonApplicability: candidate.nonApplicability,
    projectionVersion: 1,
    // Search hints affect discovery and filtering; bind both to the reviewed canonical state.
    sourceDigest: searchAliases.length || searchExclusions.length ? sha256({ candidate,
      ...(searchAliases.length ? { searchAliases } : {}), ...(searchExclusions.length ? { searchExclusions } : {}),
    }) : sha256(candidate),
    ...(searchAliases.length ? { searchAliases } : {}),
    ...(searchExclusions.length ? { searchExclusions } : {}),
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
