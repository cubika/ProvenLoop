import { z } from "zod";

import {
  finiteNumberSchema,
  identifierSchema,
  isoTimestampSchema,
  nonEmptyStringSchema,
  nonNegativeIntegerSchema,
  stringListSchema,
  versionedSchemaShape,
} from "./common.js";

export const contextFeedbackSchema = z.enum([
  "helpful",
  "ignored",
  "irrelevant",
  "wrong",
  "stale",
]);

export const contextRetrievalStatusSchema = z.enum([
  "provided",
  "no_match",
  "disabled",
  "muted",
  "degraded",
]);

export const contextUseRecordSchema = z
  .object({
    ...versionedSchemaShape,
    appliedKnowledgeIds: stringListSchema,
    branch: nonEmptyStringSchema.optional(),
    candidateKnowledgeIds: stringListSchema,
    codeVersion: nonEmptyStringSchema.optional(),
    createdAt: isoTimestampSchema,
    episodeId: identifierSchema.optional(),
    feedback: contextFeedbackSchema.optional(),
    latencyMs: finiteNumberSchema.nonnegative(),
    repoId: identifierSchema.optional(),
    renderedTokens: nonNegativeIntegerSchema,
    requestId: identifierSchema,
    retrievalStatus: contextRetrievalStatusSchema.optional(),
    returnedKnowledgeIds: stringListSchema,
    sessionId: identifierSchema,
    updatedAt: isoTimestampSchema.optional(),
  })
  .strict();

export type ContextUseRecord = z.infer<typeof contextUseRecordSchema>;
export type ContextRetrievalStatus = z.infer<
  typeof contextRetrievalStatusSchema
>;
