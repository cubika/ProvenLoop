import { z } from "zod";

import {
  identifierSchema,
  isoTimestampSchema,
  nonEmptyStringSchema,
  sha256DigestSchema,
  versionedSchemaShape,
} from "./common.js";
import {
  type SchemaValidationResult,
  validateVersionedSchema,
} from "./validation.js";

export const SUPPORTED_EVENT_TYPES = [
  "session.started",
  "session.ended",
  "prompt.submitted",
  "tool.started",
  "tool.completed",
  "file.changed",
  "test.completed",
  "build.completed",
  "git.commit",
  "pull_request.updated",
  "review.received",
  "issue.linked",
  "change.reverted",
  "user.corrected",
  "feedback.recorded",
  "claim.declared",
  "delegate.requested",
  "delegate.completed",
  "verification.completed",
] as const;

export const SUPPORTED_ADAPTER_VERSIONS: Readonly<
  Record<string, readonly string[]>
> = {
  "copilot-cli": [
    "1.0.82-0",
  ],
} as const;

export const supportedEventTypeSchema = z.enum(SUPPORTED_EVENT_TYPES);

export const trustLabelSchema = z.enum([
  "user",
  "system",
  "tool",
  "external-content",
  "model",
]);

export const completionStatusSchema = z.enum([
  "requested",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

export const rawEventSchema = z
  .object({
    ...versionedSchemaShape,
    actorId: identifierSchema.optional(),
    adapter: nonEmptyStringSchema,
    adapterVersion: nonEmptyStringSchema,
    branch: nonEmptyStringSchema.optional(),
    claimId: identifierSchema.optional(),
    commitSha: nonEmptyStringSchema.optional(),
    completionStatus: completionStatusSchema.optional(),
    eventId: identifierSchema,
    eventType: nonEmptyStringSchema,
    exitCode: z.number().int().optional(),
    operationId: identifierSchema.optional(),
    parentEventId: identifierSchema.optional(),
    participantId: identifierSchema.optional(),
    protocol: nonEmptyStringSchema.optional(),
    protocolVersion: nonEmptyStringSchema.optional(),
    redactedArguments: z.unknown().optional(),
    repoId: identifierSchema.optional(),
    requestedModel: nonEmptyStringSchema.optional(),
    requestedProvider: nonEmptyStringSchema.optional(),
    resolvedModel: nonEmptyStringSchema.optional(),
    resolvedProvider: nonEmptyStringSchema.optional(),
    resultDigest: sha256DigestSchema.optional(),
    sessionId: identifierSchema.optional(),
    timestamp: isoTimestampSchema,
    toolName: nonEmptyStringSchema.optional(),
    trust: trustLabelSchema,
    worktree: nonEmptyStringSchema.optional(),
  })
  .strict();

export const supportedRawEventSchema = rawEventSchema.extend({
  eventType: supportedEventTypeSchema,
});

export type RawEvent = z.infer<typeof rawEventSchema>;
export type SupportedEventType = z.infer<typeof supportedEventTypeSchema>;
export type SupportedRawEvent = z.infer<typeof supportedRawEventSchema>;

type RawEventValidationFailure = Exclude<
  SchemaValidationResult<RawEvent>,
  {
    readonly status: "valid";
  }
>;

export type RawEventClassification =
  | RawEventValidationFailure
  | {
      readonly status: "supported";
      readonly value: SupportedRawEvent;
    }
  | {
      readonly status: "unsupported_adapter_version";
      readonly adapter: string;
      readonly adapterVersion: string;
      readonly supportedVersions: readonly string[];
      readonly value: RawEvent;
    }
  | {
      readonly status: "unsupported_event_type";
      readonly eventType: string;
      readonly value: RawEvent;
    };

export const classifyRawEvent = (input: unknown): RawEventClassification => {
  const validation = validateVersionedSchema(
    "rawEvent",
    rawEventSchema,
    input,
  );
  if (validation.status !== "valid") {
    return validation;
  }

  const supportedVersions = SUPPORTED_ADAPTER_VERSIONS[
    validation.value.adapter
  ];
  if (
    supportedVersions === undefined ||
    !supportedVersions.some(
      (version) => version === validation.value.adapterVersion,
    )
  ) {
    return {
      status: "unsupported_adapter_version",
      adapter: validation.value.adapter,
      adapterVersion: validation.value.adapterVersion,
      supportedVersions: supportedVersions ?? [],
      value: validation.value,
    };
  }

  const eventType = supportedEventTypeSchema.safeParse(
    validation.value.eventType,
  );
  if (!eventType.success) {
    return {
      status: "unsupported_event_type",
      eventType: validation.value.eventType,
      value: validation.value,
    };
  }

  return {
    status: "supported",
    value: {
      ...validation.value,
      eventType: eventType.data,
    },
  };
};
