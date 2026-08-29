import { z } from "zod";

import {
  identifierSchema,
  isoTimestampSchema,
  nonEmptyStringSchema,
  stringListSchema,
  versionedSchemaShape,
} from "./common.js";

export const branchContextSchema = z
  .object({
    ...versionedSchemaShape,
    acceptedDecisions: stringListSchema,
    branch: nonEmptyStringSchema,
    branchContextId: identifierSchema,
    expiresAt: isoTimestampSchema.optional(),
    explicitConstraints: stringListSchema,
    goal: nonEmptyStringSchema.optional(),
    headSha: nonEmptyStringSchema,
    implementationState: stringListSchema,
    recentVerificationEvidenceIds: stringListSchema,
    repoId: identifierSchema,
    sourceEpisodeIds: stringListSchema,
    unfinishedItems: stringListSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();

export type BranchContext = z.infer<typeof branchContextSchema>;
