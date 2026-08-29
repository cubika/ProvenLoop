import { z } from "zod";

import {
  finiteNumberSchema,
  identifierSchema,
  isoTimestampSchema,
  nonEmptyStringSchema,
  stringListSchema,
  versionedSchemaShape,
} from "./common.js";

export const episodeOutcomeSchema = z.enum([
  "unknown",
  "success",
  "partial",
  "failure",
  "reverted",
]);

export const outcomeQualificationSchema = z.enum([
  "open",
  "censored",
  "qualified",
]);

export const workEpisodeSchema = z
  .object({
    ...versionedSchemaShape,
    associationConfidence: finiteNumberSchema.min(0).max(1),
    branches: stringListSchema,
    commitIds: stringListSchema,
    correctionEventIds: stringListSchema,
    episodeId: identifierSchema,
    finishedAt: isoTimestampSchema.optional(),
    goal: nonEmptyStringSchema,
    issueIds: stringListSchema,
    observationWindowEndsAt: isoTimestampSchema.optional(),
    outcome: episodeOutcomeSchema,
    outcomeEvidenceIds: stringListSchema,
    outcomeQualification: outcomeQualificationSchema,
    outcomeQualifiedAt: isoTimestampSchema.optional(),
    pullRequestIds: stringListSchema,
    repoId: identifierSchema.optional(),
    sessionIds: stringListSchema,
    startedAt: isoTimestampSchema,
  })
  .strict();

export type WorkEpisode = z.infer<typeof workEpisodeSchema>;
