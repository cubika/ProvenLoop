import {
  captureEnvelopeSchema,
  CURRENT_SCHEMA_VERSION,
  rawEventSchema,
  type CaptureEnvelope,
  type RawEvent,
} from "@provenloop/contracts";

import { sha256 } from "./digest.js";
import {
  redactCaptureContent,
  redactCaptureMetadata,
  redactPotentialSecrets,
  type CaptureContentInput,
  type CaptureRedactionLimits,
} from "./redaction.js";

export type CaptureEventInput = Omit<
  RawEvent,
  "eventId" | "redactedArguments" | "resultDigest" | "schemaVersion"
> & {
  readonly content?: CaptureContentInput;
  readonly contentDigest?: string;
  readonly internalSession?: boolean;
  readonly sessionId: string;
  readonly sourceEventId: string;
};

export interface CreateCaptureEnvelopeOptions {
  readonly capturedAt?: string;
  readonly redactionLimits?: Partial<CaptureRedactionLimits>;
}

export interface CaptureIdentityInput {
  readonly adapter: string;
  readonly adapterVersion: string;
  readonly eventType: string;
  readonly sessionId: string;
  readonly sourceEventId: string;
}

export interface RedactedCaptureEnvelopeResult {
  readonly envelope: CaptureEnvelope;
  readonly redactionApplied: boolean;
}

const definedField = <TKey extends string, TValue>(
  key: TKey,
  value: TValue | undefined,
): Partial<Record<TKey, TValue>> =>
  value === undefined
    ? {}
    : {
        [key]: value,
      } as Record<TKey, TValue>;

const sanitizeRedactionMetadata = (
  values: readonly string[],
): string[] =>
  [
    ...new Set(
      values.map((value) => redactPotentialSecrets(value)),
    ),
  ].sort();

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

export const createCaptureDeduplicationKey = (
  input: CaptureIdentityInput,
): string =>
  sha256({
    adapter: input.adapter.trim(),
    adapterVersion: input.adapterVersion.trim(),
    eventType: input.eventType.trim(),
    sessionId: input.sessionId.trim(),
    sourceEventId: input.sourceEventId.trim(),
  });

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
  if (normalizedEvent.sessionId === undefined) {
    throw new InvalidCaptureIdentityError("sessionId");
  }
  const deduplicationKey = createCaptureDeduplicationKey({
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
      ...(redacted.redaction.contentDigest === undefined &&
      input.contentDigest !== undefined
        ? {
            contentDigest: input.contentDigest,
          }
        : {}),
      redactedPaths,
    },
    sourceEventId: safeSourceEventId ?? normalizedSourceEventId,
  });
};

export const redactCaptureEnvelopeForPersistence = (
  input: CaptureEnvelope,
): RedactedCaptureEnvelopeResult => {
  const parsed = captureEnvelopeSchema.parse(input);
  const event = parsed.event;
  const contentInput: CaptureContentInput = {
    ...(parsed.content?.message === undefined
      ? {}
      : {
          message: parsed.content.message,
        }),
    ...(parsed.content?.safeError === undefined
      ? {}
      : {
          error: parsed.content.safeError,
        }),
    ...(event.redactedArguments === undefined
      ? {}
      : {
          toolArguments: event.redactedArguments,
        }),
    ...(parsed.content?.toolResult === undefined
      ? {}
      : {
          toolResult: parsed.content.toolResult,
        }),
  };
  const rebuilt = createCaptureEnvelope(
    {
      adapter: event.adapter,
      adapterVersion: event.adapterVersion,
      ...definedField("actorId", event.actorId),
      ...definedField("branch", event.branch),
      ...definedField("claimId", event.claimId),
      ...definedField("commitSha", event.commitSha),
      ...definedField(
        "completionStatus",
        event.completionStatus,
      ),
      ...(Object.keys(contentInput).length === 0
        ? {}
        : {
            content: contentInput,
          }),
      ...definedField(
        "contentDigest",
        parsed.redaction.contentDigest,
      ),
      eventType: event.eventType,
      ...definedField("exitCode", event.exitCode),
      ...definedField("operationId", event.operationId),
      ...definedField("parentEventId", event.parentEventId),
      ...definedField("participantId", event.participantId),
      ...definedField("protocol", event.protocol),
      ...definedField("protocolVersion", event.protocolVersion),
      ...definedField("repoId", event.repoId),
      ...definedField("requestedModel", event.requestedModel),
      ...definedField(
        "requestedProvider",
        event.requestedProvider,
      ),
      ...definedField("resolvedModel", event.resolvedModel),
      ...definedField(
        "resolvedProvider",
        event.resolvedProvider,
      ),
      sessionId: event.sessionId ?? "",
      sourceEventId: parsed.sourceEventId,
      timestamp: event.timestamp,
      ...definedField("toolName", event.toolName),
      trust: event.trust,
      ...definedField("worktree", event.worktree),
    },
    {
      capturedAt: parsed.capturedAt,
    },
  );
  const envelope = captureEnvelopeSchema.parse({
    ...rebuilt,
    event: {
      ...rebuilt.event,
      ...(event.resultDigest === undefined
        ? {}
        : {
            resultDigest: event.resultDigest,
          }),
    },
    redaction: {
      ...rebuilt.redaction,
      appliedRules: sanitizeRedactionMetadata([
          ...parsed.redaction.appliedRules,
          ...rebuilt.redaction.appliedRules,
      ]),
      ...(parsed.redaction.contentDigest === undefined
        ? {}
        : {
            contentDigest: parsed.redaction.contentDigest,
          }),
      droppedPaths: sanitizeRedactionMetadata([
          ...parsed.redaction.droppedPaths,
          ...rebuilt.redaction.droppedPaths,
      ]),
      redactedPaths: sanitizeRedactionMetadata([
          ...parsed.redaction.redactedPaths,
          ...rebuilt.redaction.redactedPaths,
      ]),
      truncatedPaths: sanitizeRedactionMetadata([
          ...parsed.redaction.truncatedPaths,
          ...rebuilt.redaction.truncatedPaths,
      ]),
    },
  });
  return {
    envelope,
    redactionApplied:
      JSON.stringify(envelope) !== JSON.stringify(parsed),
  };
};

export const isProvenLoopInternalEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): boolean => environment.PROVENLOOP_INTERNAL === "1";
