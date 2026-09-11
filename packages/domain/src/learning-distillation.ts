import {
  learningDistillationSchema, learningDistillationReviewSchema, learningSourceSchema,
  type LearningDistillation, type LearningDistillationReview, type RuleProposalInput,
} from "@provenloop/contracts";
import { sha256 } from "./digest.js";

interface LearningDistillationSource { readonly eventId: string; readonly digest: string }

/** Bind the reviewed proposal to the original captured window, including source text. */
export const learningDistillationInputDigest = (
  proposal: RuleProposalInput,
  sourceDigests: readonly LearningDistillationSource[],
): string => sha256({
  rule: proposal.rule, trigger: proposal.trigger, exclusions: proposal.exclusions,
  retention: proposal.retention, canonicalKey: proposal.canonicalKey,
  userSource: proposal.userSource, agentSource: proposal.agentSource, supportingSources: proposal.supportingSources,
  predicate: proposal.predicate, shellPredicate: proposal.shellPredicate,
  failedOperationEventId: proposal.failedOperationEventId, retryOperationEventId: proposal.retryOperationEventId,
  completionEventId: proposal.completionEventId,
  ...(proposal.queryTerms ? { queryTerms: proposal.queryTerms } : {}),
  sourceDigests: sourceDigests.map(({ eventId, digest }) => ({ eventId, digest })),
});

const validSources = (sources: readonly LearningDistillationSource[]): boolean =>
  sources.length > 0 && sources.length <= 32 && new Set(sources.map((source) => source.eventId)).size === sources.length &&
  sources.every((source) => learningSourceSchema.safeParse(source).success);

/** Called after independent model review. Identity, time and digests come from the host. */
export const createLearningDistillation = (
  proposal: RuleProposalInput,
  sourceDigests: readonly LearningDistillationSource[],
  review: LearningDistillationReview,
  reviewer: LearningDistillation["reviewer"],
  reviewedAt: string,
): LearningDistillation => {
  if (!validSources(sourceDigests)) throw new Error("Distillation requires valid captured source digests.");
  const assessment = learningDistillationReviewSchema.parse(review);
  const metadata = {
    ...assessment, schemaVersion: 1 as const, comparisonBasis: "provided_material" as const,
    inputDigest: learningDistillationInputDigest(proposal, sourceDigests), reviewer, reviewedAt,
  };
  // Parse before hashing so schema normalization cannot invalidate the stored digest.
  const parsed = learningDistillationSchema.parse({ ...metadata, reviewDigest: "0".repeat(64) });
  const bound = { schemaVersion: parsed.schemaVersion, inputDigest: parsed.inputDigest,
    criteria: parsed.criteria, rationale: parsed.rationale, comparisonBasis: parsed.comparisonBasis,
    reviewer: parsed.reviewer, reviewedAt: parsed.reviewedAt };
  return { ...bound, reviewDigest: sha256(bound) };
};

/**
 * Accept a complete model assessment only while its reviewed inputs and metadata
 * match. Hashes detect later edits; they are not signatures or semantic proof.
 * Acceptance never grants external verification, user confirmation or authority.
 */
export const hasAcceptedLearningDistillation = (
  proposal: RuleProposalInput,
  sourceDigests: readonly LearningDistillationSource[],
): boolean => {
  const result = learningDistillationSchema.safeParse(proposal.distillation);
  if (!result.success || !validSources(sourceDigests) || sha256(proposal.distillation) !== sha256(result.data)) return false;
  const { reviewDigest, ...bound } = result.data;
  return reviewDigest === sha256(bound) && bound.inputDigest === learningDistillationInputDigest(proposal, sourceDigests) &&
    Object.values(bound.criteria).every((accepted) => accepted);
};
