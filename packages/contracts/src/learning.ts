import { z } from "zod";
import { captureEnvelopeSchema } from "./capture.js";
import { identifierSchema, isoTimestampSchema, sha256DigestSchema } from "./common.js";

const text = z.string().trim().min(1).max(2048);
export const learningSourceSchema = z.object({
  eventId: identifierSchema, digest: sha256DigestSchema,
}).strict();
export const learningWindowSchema = z.object({
  schemaVersion: z.literal(1), windowId: identifierSchema, revision: sha256DigestSchema,
  sessionId: identifierSchema, repoId: identifierSchema, worktree: text,
  createdAt: isoTimestampSchema, sources: z.array(learningSourceSchema).min(1).max(32),
  events: z.array(captureEnvelopeSchema).min(1).max(32),
}).strict();
export const learningPredicateSchema = z.object({
  kind: z.enum(["required_argument", "absolute_path"]),
  serverName: text, toolName: text, argument: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u),
  contractDigest: sha256DigestSchema,
}).strict();
export const ruleProposalInputSchema = z.object({
  rule: text, trigger: text, exclusions: z.array(text).min(1).max(8),
  userSource: z.object({ eventId: identifierSchema, quote: text }).strict(),
  failedOperationEventId: identifierSchema, retryOperationEventId: identifierSchema,
  completionEventId: identifierSchema, predicate: learningPredicateSchema.optional(),
}).strict();
export const learningInferenceResponseSchema = z.object({
  schemaVersion: z.literal(1), proposals: z.array(ruleProposalInputSchema).max(3),
}).strict();
export const learningJobSchema = z.object({
  schemaVersion: z.literal(1), jobId: identifierSchema, windowId: identifierSchema,
  revision: sha256DigestSchema, state: z.enum(["pending", "running", "evaluated", "waiting_evidence", "paused", "failed", "cancelled", "archived"]),
  attempts: z.number().int().min(0).max(3), createdAt: isoTimestampSchema, updatedAt: isoTimestampSchema,
  expiresAt: isoTimestampSchema, deadline: isoTimestampSchema.optional(),
  provider: text.optional(), model: text.optional(), extractorVersion: text,
  result: z.enum(["no_rule", "candidate", "qualified", "error"]).optional(),
  error: z.string().max(512).optional(),
}).strict();
export const ruleProposalSchema = ruleProposalInputSchema.extend({
  schemaVersion: z.literal(1), proposalId: identifierSchema, jobId: identifierSchema,
  knowledgeId: identifierSchema, createdAt: isoTimestampSchema, expiresAt: isoTimestampSchema,
  sourceDigests: z.array(learningSourceSchema).min(1).max(32),
}).strict();
// This contract is supplied by a native adapter registry, never by model output.
export const learningToolContractSchema = z.object({
  schemaVersion: z.literal(1), serverName: text, toolName: text, version: text,
  sourceSchemaDigest: sha256DigestSchema,
  digest: sha256DigestSchema, requiredArguments: z.array(text).max(64),
  absolutePathArguments: z.array(text).max(64),
}).strict();
export const mcpRecoveryReceiptSchema = z.object({
  schemaVersion: z.literal(1), receiptId: identifierSchema, proposalId: identifierSchema,
  predicate: learningPredicateSchema, contract: learningToolContractSchema,
  failureEventId: identifierSchema, userEventId: identifierSchema,
  failedOperationEventId: identifierSchema, retryOperationEventId: identifierSchema,
  completionEventId: identifierSchema, sourceDigests: z.array(learningSourceSchema).min(5).max(32),
  verifiedAt: isoTimestampSchema, proves: z.literal("invocation_contract"),
}).strict();
export type LearningWindow = z.infer<typeof learningWindowSchema>;
export type LearningJob = z.infer<typeof learningJobSchema>;
export type LearningPredicate = z.infer<typeof learningPredicateSchema>;
export type LearningToolContract = z.infer<typeof learningToolContractSchema>;
export type RuleProposalInput = z.infer<typeof ruleProposalInputSchema>;
export type RuleProposal = z.infer<typeof ruleProposalSchema>;
export type McpRecoveryReceipt = z.infer<typeof mcpRecoveryReceiptSchema>;
