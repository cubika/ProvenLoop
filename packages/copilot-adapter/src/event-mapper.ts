import type {
  JsonValue,
  RawEvent,
} from "@provenloop/contracts";
import { isoTimestampSchema } from "@provenloop/contracts";
import type { CaptureEventInput } from "@provenloop/domain";

export interface CopilotSessionEvent {
  readonly agentId?: unknown;
  readonly data?: unknown;
  readonly ephemeral?: unknown;
  readonly id?: unknown;
  readonly parentId?: unknown;
  readonly timestamp?: unknown;
  readonly type?: unknown;
}

export interface CopilotWorkspaceSnapshot {
  readonly branch?: string;
  readonly commitSha?: string;
  readonly repoId?: string;
  readonly worktree?: string;
}

export interface CopilotCallbackCopyLimits {
  readonly maxStringChars: number;
}

export interface CopilotEventMapperOptions {
  readonly adapterVersion: string;
  readonly copyLimits: CopilotCallbackCopyLimits;
  readonly sessionId: string;
  readonly workspace?: CopilotWorkspaceSnapshot;
}

export class InvalidCopilotEventMapperConfigurationError extends Error {
  public override readonly name =
    "InvalidCopilotEventMapperConfigurationError";

  public constructor(field: string) {
    super(`Copilot event mapper ${field} is invalid.`);
  }
}

export type CopilotEventMappingResult =
  | {
      readonly status: "ignored";
      readonly eventType?: string;
      readonly reason: "ephemeral" | "internal_session";
      readonly sourceEventId?: string;
    }
  | {
      readonly status: "malformed";
      readonly eventType?: string;
      readonly issues: readonly string[];
      readonly sourceEventId?: string;
    }
  | {
      readonly status: "mapped";
      readonly value: CaptureEventInput;
    }
  | {
      readonly status: "unsupported";
      readonly value: CaptureEventInput;
    };

const intentionallyIgnoredEventTypes = new Set([
  "assistant.intent",
  "assistant.message_delta",
  "assistant.reasoning_delta",
  "assistant.streaming_delta",
  "assistant.usage",
  "session.usage_info",
  "tool.execution_partial_result",
  "tool.execution_progress",
]);

const asRecord = (
  value: unknown,
): Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};

const requiredString = (
  record: Readonly<Record<string, unknown>>,
  field: string,
  issues: string[],
): string | undefined => {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push(`${field} must be a non-empty string.`);
    return undefined;
  }
  return value;
};

const optionalString = (
  record: Readonly<Record<string, unknown>>,
  field: string,
): string | undefined => {
  const value = record[field];
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
};

const requiredBoolean = (
  record: Readonly<Record<string, unknown>>,
  field: string,
  issues: string[],
): boolean | undefined => {
  const value = record[field];
  if (typeof value !== "boolean") {
    issues.push(`${field} must be a boolean.`);
    return undefined;
  }
  return value;
};

const optionalFiniteNumber = (
  record: Readonly<Record<string, unknown>>,
  field: string,
): number | undefined => {
  const value = record[field];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
};

const positiveInteger = (
  value: number,
  field: string,
): number => {
  if (!Number.isInteger(value) || value <= 0) {
    throw new InvalidCopilotEventMapperConfigurationError(field);
  }
  return value;
};

const normalizedWorkspace = (
  snapshot: CopilotWorkspaceSnapshot,
): CopilotWorkspaceSnapshot => ({
  ...(snapshot.branch?.trim()
    ? {
        branch: snapshot.branch.trim(),
      }
    : {}),
  ...(snapshot.commitSha?.trim()
    ? {
        commitSha: snapshot.commitSha.trim(),
      }
    : {}),
  ...(snapshot.repoId?.trim()
    ? {
        repoId: snapshot.repoId.trim(),
      }
    : {}),
  ...(snapshot.worktree?.trim()
    ? {
        worktree: snapshot.worktree.trim(),
      }
    : {}),
});

const copyBoundedValue = (
  value: unknown,
  limits: CopilotCallbackCopyLimits,
): JsonValue | undefined => {
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return value.slice(0, limits.maxStringChars);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    return {
      itemCount: value.length,
      kind: "array",
      status: "omitted_in_callback",
    };
  }
  if (value !== null && typeof value === "object") {
    return {
      kind: "object",
      status: "omitted_in_callback",
    };
  }
  return undefined;
};

const copyToolResult = (
  value: unknown,
  limits: CopilotCallbackCopyLimits,
): JsonValue | undefined => {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return copyBoundedValue(value, limits);
  }
  const record = asRecord(value);
  const content = optionalString(record, "content");
  const detailedContent = optionalString(record, "detailedContent");
  const contents = record.contents;
  const structuredContent = record.structuredContent;
  if (
    content === undefined &&
    detailedContent === undefined &&
    !Array.isArray(contents) &&
    structuredContent === undefined
  ) {
    return copyBoundedValue(value, limits);
  }
  return {
    ...(content === undefined
      ? {}
      : {
          content: content.slice(0, limits.maxStringChars),
        }),
    ...(detailedContent === undefined
      ? {}
      : {
          detailedContent: detailedContent.slice(
            0,
            limits.maxStringChars,
          ),
        }),
    ...(Array.isArray(contents)
      ? {
          contentBlocks: {
            itemCount: contents.length,
            status: "omitted_in_callback",
          },
        }
      : {}),
    ...(structuredContent === undefined
      ? {}
      : {
          structuredContent: {
            kind: Array.isArray(structuredContent)
              ? "array"
              : structuredContent === null
                ? "null"
                : typeof structuredContent,
            status: "omitted_in_callback",
          },
        }),
  };
};

const copyError = (
  value: unknown,
  limits: CopilotCallbackCopyLimits,
): JsonValue | undefined => {
  if (typeof value === "string") {
    return value.slice(0, limits.maxStringChars);
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return copyBoundedValue(value, limits);
  }
  const record = asRecord(value);
  const code = optionalString(record, "code");
  const message = optionalString(record, "message");
  const name = optionalString(record, "name");
  return {
    ...(code === undefined ? {} : { code }),
    ...(message === undefined
      ? {}
      : {
          message: message.slice(0, limits.maxStringChars),
        }),
    ...(name === undefined ? {} : { name }),
  };
};

const userMessageTrust = (
  data: Readonly<Record<string, unknown>>,
): RawEvent["trust"] => {
  if (data.isAutopilotContinuation === true) {
    return "system";
  }
  const source = optionalString(data, "source");
  if (source?.startsWith("agent-") === true) {
    return "model";
  }
  return source === undefined || source === "user"
    ? "user"
    : "system";
};

const messageContent = (
  data: Readonly<Record<string, unknown>>,
  limits: CopilotCallbackCopyLimits,
  issues: string[],
): string | undefined => {
  const content = data.content;
  if (typeof content !== "string") {
    issues.push("content must be a string.");
    return undefined;
  }
  return content.length === 0
    ? undefined
    : content.slice(0, limits.maxStringChars);
};

export class CopilotEventMapper {
  readonly #adapterVersion: string;
  readonly #copyLimits: CopilotCallbackCopyLimits;
  readonly #sessionId: string;
  readonly #toolNames = new Map<string, string>();
  #workspace: CopilotWorkspaceSnapshot;

  public constructor(options: CopilotEventMapperOptions) {
    if (options.adapterVersion.trim().length === 0) {
      throw new InvalidCopilotEventMapperConfigurationError(
        "adapterVersion",
      );
    }
    if (options.sessionId.trim().length === 0) {
      throw new InvalidCopilotEventMapperConfigurationError(
        "sessionId",
      );
    }
    this.#adapterVersion = options.adapterVersion.trim();
    this.#copyLimits = {
      maxStringChars: positiveInteger(
        options.copyLimits.maxStringChars,
        "copyLimits.maxStringChars",
      ),
    };
    this.#sessionId = options.sessionId.trim();
    this.#workspace = normalizedWorkspace(options.workspace ?? {});
  }

  public updateWorkspace(snapshot: CopilotWorkspaceSnapshot): void {
    this.#workspace = normalizedWorkspace(snapshot);
  }

  public sessionStarted(
    timestamp = new Date().toISOString(),
  ): CaptureEventInput {
    return {
      ...this.#base(
        `extension-start-${this.#sessionId}`,
        "session.started",
        timestamp,
        "system",
      ),
    };
  }

  public map(input: unknown): CopilotEventMappingResult {
    if (
      input === null ||
      typeof input !== "object" ||
      Array.isArray(input)
    ) {
      return {
        issues: [
          "event must be an object.",
        ],
        status: "malformed",
      };
    }
    const event = input as Readonly<Record<string, unknown>>;
    const issues: string[] = [];
    const sourceEventId =
      typeof event.id === "string" && event.id.trim().length > 0
        ? event.id
        : undefined;
    const eventType =
      typeof event.type === "string" && event.type.trim().length > 0
        ? event.type
        : undefined;
    const parsedTimestamp = isoTimestampSchema.safeParse(
      event.timestamp,
    );
    const timestamp = parsedTimestamp.success
      ? parsedTimestamp.data
      : undefined;
    if (sourceEventId === undefined) {
      issues.push("id must be a non-empty string.");
    }
    if (eventType === undefined) {
      issues.push("type must be a non-empty string.");
    }
    if (timestamp === undefined) {
      issues.push("timestamp must be an ISO-8601 string.");
    }
    if (!Object.prototype.hasOwnProperty.call(event, "parentId")) {
      issues.push("parentId is required.");
    } else if (event.parentId !== null) {
      if (
        typeof event.parentId !== "string" ||
        event.parentId.trim().length === 0
      ) {
        issues.push("parentId must be a non-empty string or null.");
      }
    }
    if (event.agentId !== undefined) {
      if (
        typeof event.agentId !== "string" ||
        event.agentId.trim().length === 0
      ) {
        issues.push("agentId must be a non-empty string when present.");
      }
    }
    if (
      !Object.prototype.hasOwnProperty.call(event, "data") ||
      event.data === null ||
      typeof event.data !== "object" ||
      Array.isArray(event.data)
    ) {
      issues.push("data must be an object.");
    }
    if (
      sourceEventId === undefined ||
      eventType === undefined ||
      timestamp === undefined ||
      issues.length > 0
    ) {
      return {
        status: "malformed",
        ...(eventType === undefined ? {} : { eventType }),
        issues,
        ...(sourceEventId === undefined ? {} : { sourceEventId }),
      };
    }

    const data = asRecord(event.data);
    const common = {
      ...this.#base(
        sourceEventId,
        eventType,
        timestamp,
        "system",
      ),
      ...(typeof event.parentId === "string"
        ? {
            parentEventId: event.parentId,
          }
        : {}),
      ...(typeof event.agentId === "string"
        ? {
            participantId: event.agentId,
          }
        : {}),
    };

    switch (eventType) {
      case "session.start": {
        const sessionId = requiredString(data, "sessionId", issues);
        const copilotVersion = requiredString(
          data,
          "copilotVersion",
          issues,
        );
        const fileVersion = data.version;
        if (!Number.isInteger(fileVersion)) {
          issues.push("version must be an integer.");
        }
        if (
          sessionId !== undefined &&
          sessionId.trim() !== this.#sessionId
        ) {
          issues.push(
            "session.start sessionId does not match the capture session.",
          );
        }
        if (
          copilotVersion !== undefined &&
          copilotVersion.trim() !== this.#adapterVersion
        ) {
          issues.push(
            "session.start copilotVersion does not match the adapter.",
          );
        }
        const context = asRecord(data.context);
        const branch =
          context === undefined
            ? undefined
            : optionalString(context, "branch");
        const commitSha =
          context === undefined
            ? undefined
            : optionalString(context, "headCommit");
        const repoId =
          context === undefined
            ? undefined
            : optionalString(context, "repository");
        const worktree =
          context === undefined
            ? undefined
            : optionalString(context, "gitRoot") ??
              optionalString(context, "cwd");
        if (issues.length === 0) {
          this.updateWorkspace({
            ...(branch === undefined ? {} : { branch }),
            ...(commitSha === undefined ? {} : { commitSha }),
            ...(repoId === undefined ? {} : { repoId }),
            ...(worktree === undefined ? {} : { worktree }),
          });
        }
        return this.#mappedOrMalformed(
          issues,
          eventType,
          sourceEventId,
          {
            ...this.#base(
              sourceEventId,
              "session.started",
              timestamp,
              "system",
            ),
            protocol: "copilot-session-file",
            ...(Number.isInteger(fileVersion)
              ? {
                  protocolVersion: String(fileVersion),
                }
              : {}),
          },
        );
      }
      case "user.message": {
        const content = messageContent(
          data,
          this.#copyLimits,
          issues,
        );
        const source = optionalString(data, "source");
        const autopilotContinuation =
          data.isAutopilotContinuation === true;
        return this.#mappedOrMalformed(
          issues,
          eventType,
          sourceEventId,
          {
            ...common,
            eventType: "prompt.submitted",
            ...(source === undefined && !autopilotContinuation
              ? {}
              : {
                  actorId:
                    source ??
                    "copilot-autopilot-continuation",
                }),
            trust: userMessageTrust(data),
            ...(content === undefined
              ? {}
              : {
                  content: {
                    message: content,
                  },
                }),
          },
        );
      }
      case "tool.execution_start": {
        const toolCallId = requiredString(
          data,
          "toolCallId",
          issues,
        );
        const toolName = requiredString(data, "toolName", issues);
        if (toolCallId !== undefined && toolName !== undefined) {
          this.#toolNames.set(toolCallId, toolName);
        }
        const toolArguments = copyBoundedValue(
          data.arguments,
          this.#copyLimits,
        );
        const model = optionalString(data, "model");
        return this.#mappedOrMalformed(
          issues,
          eventType,
          sourceEventId,
          {
            ...common,
            eventType: "tool.started",
            completionStatus: "running",
            ...(toolCallId === undefined
              ? {}
              : {
                  operationId: toolCallId,
                }),
            ...(toolName === undefined ? {} : { toolName }),
            ...(model === undefined ? {} : { resolvedModel: model }),
            trust: "tool",
            ...(toolArguments === undefined
              ? {}
              : {
                  content: {
                    toolArguments,
                  },
                }),
          },
        );
      }
      case "tool.execution_complete": {
        const toolCallId = requiredString(
          data,
          "toolCallId",
          issues,
        );
        const success = requiredBoolean(data, "success", issues);
        const toolName =
          toolCallId === undefined
            ? undefined
            : this.#toolNames.get(toolCallId);
        if (toolCallId !== undefined) {
          this.#toolNames.delete(toolCallId);
        }
        const toolResult = copyToolResult(
          data.result,
          this.#copyLimits,
        );
        const error = copyError(
          data.error,
          this.#copyLimits,
        );
        const model = optionalString(data, "model");
        return this.#mappedOrMalformed(
          issues,
          eventType,
          sourceEventId,
          {
            ...common,
            eventType:
              success === false ? "tool.failed" : "tool.completed",
            completionStatus:
              success === false ? "failed" : "succeeded",
            ...(toolCallId === undefined
              ? {}
              : {
                  operationId: toolCallId,
                }),
            ...(toolName === undefined ? {} : { toolName }),
            ...(model === undefined ? {} : { resolvedModel: model }),
            trust: "tool",
            ...(
              toolResult === undefined && error === undefined
                ? {}
                : {
                    content: {
                      ...(error === undefined ? {} : { error }),
                      ...(toolResult === undefined
                        ? {}
                        : {
                            toolResult,
                          }),
                    },
                  }
            ),
          },
        );
      }
      case "assistant.message": {
        const messageId = requiredString(
          data,
          "messageId",
          issues,
        );
        const content = messageContent(
          data,
          this.#copyLimits,
          issues,
        );
        const model = optionalString(data, "model");
        return this.#mappedOrMalformed(
          issues,
          eventType,
          sourceEventId,
          {
            ...common,
            eventType: "agent.message",
            ...(messageId === undefined
              ? {}
              : {
                  operationId: messageId,
                }),
            ...(model === undefined ? {} : { resolvedModel: model }),
            trust: "model",
            ...(content === undefined
              ? {}
              : {
                  content: {
                    message: content,
                  },
                }),
          },
        );
      }
      case "assistant.turn_end": {
        const turnId = requiredString(data, "turnId", issues);
        const model = optionalString(data, "model");
        return this.#mappedOrMalformed(
          issues,
          eventType,
          sourceEventId,
          {
            ...common,
            eventType: "agent.turn_completed",
            completionStatus: "succeeded",
            ...(turnId === undefined ? {} : { operationId: turnId }),
            ...(model === undefined ? {} : { resolvedModel: model }),
            trust: "model",
          },
        );
      }
      case "session.idle":
        return {
          status: "mapped",
          value: {
            ...common,
            eventType: "session.idle",
            trust: "system",
            ...(data.aborted === true
              ? {
                  completionStatus: "cancelled",
                }
              : {}),
          },
        };
      case "session.error": {
        const errorType = requiredString(
          data,
          "errorType",
          issues,
        );
        const message = requiredString(data, "message", issues);
        const statusCode = optionalFiniteNumber(data, "statusCode");
        return this.#mappedOrMalformed(
          issues,
          eventType,
          sourceEventId,
          {
            ...common,
            eventType: "session.error",
            completionStatus: "failed",
            ...(optionalString(data, "providerCallId") === undefined
              ? {}
              : {
                  operationId: optionalString(
                    data,
                    "providerCallId",
                  ),
                }),
            trust: "system",
            ...(
              errorType === undefined || message === undefined
                ? {}
                : {
                    content: {
                      error: {
                        ...(statusCode === undefined
                          ? {}
                          : {
                              code: String(statusCode),
                            }),
                        message,
                        name: errorType,
                      },
                    },
                  }
            ),
          },
        );
      }
      case "session.context_changed": {
        const cwd = requiredString(data, "cwd", issues);
        const branch = optionalString(data, "branch");
        const gitRoot = optionalString(data, "gitRoot");
        const headCommit = optionalString(data, "headCommit");
        const repository = optionalString(data, "repository");
        const worktree = gitRoot ?? cwd;
        if (data.pendingGitContext === true) {
          return this.#mappedOrMalformed(
            issues,
            eventType,
            sourceEventId,
            common,
            "unsupported",
          );
        }
        const snapshot = normalizedWorkspace({
          ...(branch === undefined
            ? {}
            : {
                branch,
              }),
          ...(repository === undefined
            ? {}
            : {
                repoId: repository,
              }),
          ...(headCommit === undefined
            ? {}
            : {
                commitSha: headCommit,
              }),
          ...(worktree === undefined
            ? {}
            : {
                worktree,
              }),
        });
        if (issues.length === 0) {
          this.updateWorkspace(snapshot);
        }
        const updatedCommon = {
          ...this.#base(
            sourceEventId,
            eventType,
            timestamp,
            "system",
          ),
          ...(typeof event.parentId === "string"
            ? {
                parentEventId: event.parentId,
              }
            : {}),
          ...(typeof event.agentId === "string"
            ? {
                participantId: event.agentId,
              }
            : {}),
        };
        return this.#mappedOrMalformed(
          issues,
          eventType,
          sourceEventId,
          {
            ...updatedCommon,
            eventType,
          },
          "unsupported",
        );
      }
      case "session.shutdown": {
        const rawShutdownType = requiredString(
          data,
          "shutdownType",
          issues,
        );
        const shutdownType =
          rawShutdownType === "routine" || rawShutdownType === "error"
            ? rawShutdownType
            : undefined;
        if (
          rawShutdownType !== undefined &&
          shutdownType === undefined
        ) {
          issues.push(
            "shutdownType must be either routine or error.",
          );
        }
        const codeChangesRecord = asRecord(data.codeChanges);
        const filesModified = Array.isArray(
          codeChangesRecord.filesModified,
        )
          ? codeChangesRecord.filesModified.length
          : undefined;
        const linesAdded = optionalFiniteNumber(
          codeChangesRecord,
          "linesAdded",
        );
        const linesRemoved = optionalFiniteNumber(
          codeChangesRecord,
          "linesRemoved",
        );
        const codeChanges: JsonValue | undefined =
          filesModified === undefined &&
          linesAdded === undefined &&
          linesRemoved === undefined
            ? undefined
            : {
                ...(filesModified === undefined
                  ? {}
                  : { filesModified }),
                ...(linesAdded === undefined ? {} : { linesAdded }),
                ...(linesRemoved === undefined
                  ? {}
                  : { linesRemoved }),
              };
        return this.#mappedOrMalformed(
          issues,
          eventType,
          sourceEventId,
          {
            ...common,
            eventType: "session.ended",
            completionStatus:
              shutdownType === "error" ? "failed" : "succeeded",
            ...(optionalString(data, "currentModel") === undefined
              ? {}
              : {
                  resolvedModel: optionalString(
                    data,
                    "currentModel",
                  ),
                }),
            trust: "system",
            ...(
              codeChanges === undefined &&
              optionalString(data, "errorReason") === undefined
                ? {}
                : {
                    content: {
                      ...(optionalString(data, "errorReason") ===
                      undefined
                        ? {}
                        : {
                            error: optionalString(
                              data,
                              "errorReason",
                            ),
                          }),
                      ...(codeChanges === undefined
                        ? {}
                        : {
                            toolResult: {
                              codeChanges,
                              shutdownType:
                                shutdownType ?? "unknown",
                            },
                          }),
                    },
                  }
            ),
          },
        );
      }
      case "subagent.started":
      case "subagent.completed":
      case "subagent.failed":
        return this.#mapSubagent(
          common,
          data,
          eventType,
          sourceEventId,
          issues,
        );
      default:
        if (
          event.ephemeral === true ||
          intentionallyIgnoredEventTypes.has(eventType)
        ) {
          return {
            status: "ignored",
            eventType,
            reason: "ephemeral",
            sourceEventId,
          };
        }
        return {
          status: "unsupported",
          value: common,
        };
    }
  }

  #mapSubagent(
    common: CaptureEventInput,
    data: Readonly<Record<string, unknown>>,
    eventType:
      | "subagent.completed"
      | "subagent.failed"
      | "subagent.started",
    sourceEventId: string,
    issues: string[],
  ): CopilotEventMappingResult {
    const toolCallId = requiredString(data, "toolCallId", issues);
    const agentName = requiredString(data, "agentName", issues);
    const model = optionalString(data, "model");
    const error =
      eventType === "subagent.failed"
        ? requiredString(data, "error", issues)
        : undefined;
    const cancelled =
      eventType === "subagent.completed" &&
      data.cancelled === true;
    const durationMs = optionalFiniteNumber(data, "durationMs");
    const totalTokens = optionalFiniteNumber(data, "totalTokens");
    const totalToolCalls = optionalFiniteNumber(
      data,
      "totalToolCalls",
    );
    const metrics: JsonValue | undefined =
      durationMs === undefined &&
      totalTokens === undefined &&
      totalToolCalls === undefined
        ? undefined
        : {
            ...(durationMs === undefined ? {} : { durationMs }),
            ...(totalTokens === undefined ? {} : { totalTokens }),
            ...(totalToolCalls === undefined
              ? {}
              : { totalToolCalls }),
          };
    return this.#mappedOrMalformed(
      issues,
      eventType,
      sourceEventId,
      {
        ...common,
        eventType,
        ...(toolCallId === undefined
          ? {}
          : {
              operationId: toolCallId,
            }),
        ...(agentName === undefined
          ? {}
          : {
              participantId: common.participantId ?? agentName,
              toolName: `subagent:${agentName}`,
            }),
        ...(eventType === "subagent.started"
          ? {
              completionStatus: "running" as const,
              ...(model === undefined
                ? {}
                : {
                    requestedModel: model,
                  }),
            }
          : {
              completionStatus:
                eventType === "subagent.failed"
                  ? "failed" as const
                  : cancelled
                    ? "cancelled" as const
                    : "succeeded" as const,
              ...(model === undefined
                ? {}
                : {
                    resolvedModel: model,
                  }),
            }),
        trust: "model",
        ...(
          error === undefined && metrics === undefined
            ? {}
            : {
                content: {
                  ...(error === undefined ? {} : { error }),
                  ...(metrics === undefined
                    ? {}
                    : {
                        toolResult: metrics,
                      }),
                },
              }
        ),
      },
    );
  }

  #base(
    sourceEventId: string,
    eventType: string,
    timestamp: string,
    trust: RawEvent["trust"],
  ): CaptureEventInput {
    return {
      adapter: "copilot-cli",
      adapterVersion: this.#adapterVersion,
      eventType,
      sessionId: this.#sessionId,
      sourceEventId,
      timestamp,
      trust,
      ...this.#workspace,
    };
  }

  #mappedOrMalformed(
    issues: readonly string[],
    eventType: string,
    sourceEventId: string,
    value: CaptureEventInput,
    validStatus: "mapped" | "unsupported" = "mapped",
  ): CopilotEventMappingResult {
    return issues.length === 0
      ? {
          status: validStatus,
          value,
        }
      : {
          status: "malformed",
          eventType,
          issues,
          sourceEventId,
        };
  }
}
