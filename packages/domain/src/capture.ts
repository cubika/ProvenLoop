import {
  captureEnvelopeSchema,
  CURRENT_SCHEMA_VERSION,
  rawEventSchema,
  type CaptureEnvelope,
  type RawEvent,
} from "@provenloop/contracts";

import { sha256 } from "./digest.js";
import {
  redactCaptureMetadata,
  redactCaptureContent,
  type CaptureContentInput,
  type CaptureRedactionLimits,
} from "./redaction.js";

export type CaptureEventInput = Omit<
  RawEvent,
  "eventId" | "redactedArguments" | "resultDigest" | "schemaVersion"
> & {
  readonly content?: CaptureContentInput;
  readonly internalSession?: boolean;
  readonly sessionId: string;
  readonly sourceEventId: string;
};

export interface CreateCaptureEnvelopeOptions {
  readonly capturedAt?: string;
  readonly redactionLimits?: Partial<CaptureRedactionLimits>;
}

export class InternalCaptureEventError extends Error {
  public override readonly name = "InternalCaptureEventError";

  public constructor() {
    super("Internal ProvenLoop sessions cannot enter the capture queue.");
  }
}

export class InvalidCaptureIdentityError extends Error {
  public override readonly name = "InvalidCaptureIdentityError";

  public constructor(field: "sessionId" | "sourceEventId") {
    super(`Capture event ${field} must be non-empty.`);
  }
}

export const createCaptureEnvelope = (
  input: CaptureEventInput,
  options: CreateCaptureEnvelopeOptions = {},
): CaptureEnvelope => {
  if (input.internalSession === true) {
    throw new InternalCaptureEventError();
  }
  const normalizedSourceEventId = input.sourceEventId.trim();
  if (input.sessionId.trim().length === 0) {
    throw new InvalidCaptureIdentityError("sessionId");
  }
  if (normalizedSourceEventId.length === 0) {
    throw new InvalidCaptureIdentityError("sourceEventId");
  }

  const normalizedEvent = rawEventSchema.parse({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    actorId: input.actorId,
    adapter: input.adapter,
    adapterVersion: input.adapterVersion,
    branch: input.branch,
    claimId: input.claimId,
    commitSha: input.commitSha,
    completionStatus: input.completionStatus,
    eventId: "event-normalization-placeholder",
    eventType: input.eventType,
    exitCode: input.exitCode,
    operationId: input.operationId,
    parentEventId: input.parentEventId,
    participantId: input.participantId,
    protocol: input.protocol,
    protocolVersion: input.protocolVersion,
    repoId: input.repoId,
    requestedModel: input.requestedModel,
    requestedProvider: input.requestedProvider,
    resolvedModel: input.resolvedModel,
    resolvedProvider: input.resolvedProvider,
    sessionId: input.sessionId,
    timestamp: input.timestamp,
    toolName: input.toolName,
    trust: input.trust,
    worktree: input.worktree,
  });
  const deduplicationKey = sha256({
    adapter: normalizedEvent.adapter,
    adapterVersion: normalizedEvent.adapterVersion,
    eventType: normalizedEvent.eventType,
    sessionId: normalizedEvent.sessionId,
    sourceEventId: normalizedSourceEventId,
  });
  const redacted = redactCaptureContent(
    input.content,
    options.redactionLimits,
  );
  const metadata = redactCaptureMetadata(
    {
      actorId: normalizedEvent.actorId,
      adapter: normalizedEvent.adapter,
      adapterVersion: normalizedEvent.adapterVersion,
      branch: normalizedEvent.branch,
      claimId: normalizedEvent.claimId,
      commitSha: normalizedEvent.commitSha,
      eventType: normalizedEvent.eventType,
      operationId: normalizedEvent.operationId,
      parentEventId: normalizedEvent.parentEventId,
      participantId: normalizedEvent.participantId,
      protocol: normalizedEvent.protocol,
      protocolVersion: normalizedEvent.protocolVersion,
      repoId: normalizedEvent.repoId,
      requestedModel: normalizedEvent.requestedModel,
      requestedProvider: normalizedEvent.requestedProvider,
      resolvedModel: normalizedEvent.resolvedModel,
      resolvedProvider: normalizedEvent.resolvedProvider,
      sessionId: normalizedEvent.sessionId,
      sourceEventId: normalizedSourceEventId,
      toolName: normalizedEvent.toolName,
      worktree: normalizedEvent.worktree,
    },
    new Set([
      "actorId",
      "claimId",
      "commitSha",
      "operationId",
      "parentEventId",
      "participantId",
      "repoId",
      "sessionId",
      "sourceEventId",
    ]),
  );
  const appliedRules = [
    ...new Set([
      ...redacted.redaction.appliedRules,
      ...metadata.appliedRules,
    ]),
  ].sort();
  const redactedPaths = [
    ...new Set([
      ...redacted.redaction.redactedPaths,
      ...metadata.redactedPaths,
    ]),
  ].sort();
  const {
    sourceEventId: safeSourceEventId,
    ...safeEventMetadata
  } = metadata.values;
  const event = rawEventSchema.parse({
    ...normalizedEvent,
    ...safeEventMetadata,
    eventId: `event-${deduplicationKey}`,
    ...(redacted.redactedArguments === undefined
      ? {}
      : {
          redactedArguments: redacted.redactedArguments,
        }),
    ...(redacted.resultDigest === undefined
      ? {}
      : {
          resultDigest: redacted.resultDigest,
        }),
  });

  return captureEnvelopeSchema.parse({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    capturedAt: options.capturedAt ?? new Date().toISOString(),
    ...(redacted.content === undefined
      ? {}
      : {
          content: redacted.content,
        }),
    deduplicationKey,
    event,
    redaction: {
      ...redacted.redaction,
      appliedRules,
      redactedPaths,
    },
    sourceEventId: safeSourceEventId ?? normalizedSourceEventId,
  });
};

export const isProvenLoopInternalEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): boolean => environment.PROVENLOOP_INTERNAL === "1";
