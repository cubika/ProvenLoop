import { z } from "zod";

import {
  finiteNumberSchema,
  identifierSchema,
  isoTimestampSchema,
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

export const contextUseRecordSchema = z
  .object({
    ...versionedSchemaShape,
    appliedKnowledgeIds: stringListSchema,
    candidateKnowledgeIds: stringListSchema,
    createdAt: isoTimestampSchema,
    episodeId: identifierSchema.optional(),
    feedback: contextFeedbackSchema.optional(),
    latencyMs: finiteNumberSchema.nonnegative(),
    renderedTokens: nonNegativeIntegerSchema,
    requestId: identifierSchema,
    returnedKnowledgeIds: stringListSchema,
    sessionId: identifierSchema,
  })
  .strict();

export type ContextUseRecord = z.infer<typeof contextUseRecordSchema>;
