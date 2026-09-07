import type { KnowledgeCandidate, RuleProposal } from "@provenloop/contracts";
import type { KnowledgeRetrievalQuery } from "./types.js";

const normalize = (text: string): string =>
  text.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/gu, " ").trim();

export const learningApplicable = (
  candidate: KnowledgeCandidate,
  proposals: readonly RuleProposal[],
  query: KnowledgeRetrievalQuery,
): boolean => {
  const sources = proposals.filter((proposal) => proposal.knowledgeId === candidate.knowledgeId);
  if (!candidate.knowledgeId.startsWith("learning-knowledge-") && sources.length === 0) return true;
  const tool = query.toolInvocation;
  if (tool === undefined || candidate.scope !== "repository" ||
      candidate.scopeId !== query.repositoryScopeId || sources.length === 0) return false;
  if (!sources.some(({ predicate, sourceDigests }) => predicate !== undefined &&
      sourceDigests.length === candidate.sourceEvidenceIds.length &&
      sourceDigests.every((source) => candidate.sourceEvidenceIds.includes(source.eventId)) &&
      predicate.serverName === tool.serverName && predicate.toolName === tool.toolName &&
      predicate.contractDigest === tool.contractDigest)) return false;
  const guidance = normalize(candidate.content);
  return !(query.projectInstructions ?? []).some((instruction) =>
    normalize(instruction).includes(guidance));
};
