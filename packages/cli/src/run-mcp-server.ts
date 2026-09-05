import {
  randomUUID,
} from "node:crypto";
import {
  access,
} from "node:fs/promises";
import { createInterface } from "node:readline";
import type {
  Readable,
  Writable,
} from "node:stream";

import {
  CopilotCliAdapter,
  assertCopilotAdapterDataRoot,
  readCopilotAdapterState,
} from "@provenloop/copilot-adapter";
import {
  PROVENLOOP_VERSION,
  type Scope,
} from "@provenloop/contracts";
import {
  sanitizeDiagnostic,
} from "@provenloop/domain";
import {
  resolveWindowsProvenLoopDataRoot,
  resolveWindowsProvenLoopLeaseName,
  resolveWindowsProvenLoopPaths,
  WindowsNamedPipeLeaseProvider,
} from "@provenloop/platform-windows";
import {
  ContextRetrievalService,
  DEFAULT_CONTEXT_TIMEOUT_MS,
  MAX_CONTEXT_TOKENS,
  SqliteFtsKnowledgeBackend,
  knowledgeProjectionFromCandidate,
  type ContextExplanation,
  type ContextFeedbackAction,
  type ContextFeedbackRequest,
  type ContextFeedbackResponse,
  type ContextRequest,
  type ContextResponse,
} from "@provenloop/retrieval";
import {
  CanonicalSqliteStore,
} from "@provenloop/storage-sqlite";

interface JsonRpcRequest {
  readonly id?: number | string | null;
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: unknown;
}

interface ToolCall {
  readonly arguments: unknown;
  readonly name: string;
}

export interface McpServerIo {
  readonly input: Readable;
  readonly output: Writable;
}

export interface McpToolHandlers {
  context(request: ContextRequest): Promise<ContextResponse>;
  explain(request: {
    readonly explanationRef: string;
    readonly sessionId: string;
  }): Promise<ContextExplanation>;
  feedback(
    request: ContextFeedbackRequest,
  ): Promise<ContextFeedbackResponse>;
}

export interface McpServerOptions {
  readonly cwd?: string;
  readonly dataRoot?: string;
  readonly handlers?: McpToolHandlers;
  readonly now?: () => Date;
  readonly sessionId?: string;
  readonly workflowScopeId?: string;
}

interface TrustedMcpContext {
  readonly cwd: string;
  readonly sessionId: string;
  readonly workflowScopeId?: string;
}

const MCP_PROTOCOL_VERSION = "2025-06-18";

const send = (
  output: Writable,
  message: Readonly<Record<string, unknown>>,
): void => {
  output.write(`${JSON.stringify(message)}\n`);
};

const respond = (
  output: Writable,
  id: JsonRpcRequest["id"],
  result: unknown,
): void => {
  send(output, {
    id: id ?? null,
    jsonrpc: "2.0",
    result,
  });
};

const fail = (
  output: Writable,
  id: JsonRpcRequest["id"],
  code: number,
  message: string,
): void => {
  send(output, {
    error: {
      code,
      message,
    },
    id: id ?? null,
    jsonrpc: "2.0",
  });
};

const isRecord = (
  input: unknown,
): input is Readonly<Record<string, unknown>> =>
  input !== null && typeof input === "object" && !Array.isArray(input);

const nonEmptyString = (
  input: unknown,
): string | undefined =>
  typeof input === "string" && input.trim().length > 0
    ? input.trim()
    : undefined;

const optionalString = (
  input: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined =>
  input[key] === undefined
    ? undefined
    : nonEmptyString(input[key]);

const hasOnlyKeys = (
  input: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean => {
  const allowed = new Set(keys);
  return Object.keys(input).every((key) => allowed.has(key));
};

const asRequest = (input: unknown): JsonRpcRequest | undefined => {
  const id = isRecord(input) ? input.id : undefined;
  if (
    !isRecord(input) ||
    input.jsonrpc !== "2.0" ||
    typeof input.method !== "string" ||
    (
      id !== undefined &&
      id !== null &&
      typeof id !== "string" &&
      typeof id !== "number"
    )
  ) {
    return undefined;
  }
  return {
    jsonrpc: "2.0",
    method: input.method,
    ...(id === undefined
      ? {}
      : {
          id,
        }),
    ...(input.params === undefined
      ? {}
      : {
          params: input.params,
        }),
  };
};

const asToolCall = (input: unknown): ToolCall | undefined => {
  if (!isRecord(input)) {
    return undefined;
  }
  const name = nonEmptyString(input.name);
  if (name === undefined) {
    return undefined;
  }
  return {
    arguments: input.arguments ?? {},
    name,
  };
};

const stringList = (
  input: unknown,
): readonly string[] | undefined => {
  if (input === undefined) {
    return undefined;
  }
  if (
    !Array.isArray(input) ||
    input.some(
      (value) =>
        typeof value !== "string" ||
        value.trim().length === 0,
    )
  ) {
    return undefined;
  }
  return input.map((value) => value.trim());
};

const parseContextRequest = (
  input: unknown,
  trusted: TrustedMcpContext,
): ContextRequest | undefined => {
  if (
    !isRecord(input) ||
    !hasOnlyKeys(input, [
      "fileHints",
      "prompt",
      "tokenBudget",
    ])
  ) {
    return undefined;
  }
  const prompt = nonEmptyString(input.prompt);
  const fileHints = stringList(input.fileHints);
  if (
    prompt === undefined ||
    typeof input.tokenBudget !== "number" ||
    !Number.isInteger(input.tokenBudget) ||
    input.tokenBudget <= 0 ||
    input.tokenBudget > MAX_CONTEXT_TOKENS ||
    (
      input.fileHints !== undefined &&
      fileHints === undefined
    )
  ) {
    return undefined;
  }
  return {
    cwd: trusted.cwd,
    ...(fileHints === undefined
      ? {}
      : {
          fileHints,
        }),
    prompt,
    sessionId: trusted.sessionId,
    tokenBudget: input.tokenBudget,
    ...(trusted.workflowScopeId === undefined
      ? {}
      : {
          workflowScopeId: trusted.workflowScopeId,
        }),
  };
};

const parseExplainRequest = (
  input: unknown,
  trusted: TrustedMcpContext,
):
  | {
      readonly explanationRef: string;
      readonly sessionId: string;
    }
  | undefined => {
  if (
    !isRecord(input) ||
    !hasOnlyKeys(input, [
      "explanationRef",
    ])
  ) {
    return undefined;
  }
  const explanationRef = nonEmptyString(input.explanationRef);
  return explanationRef === undefined
    ? undefined
    : {
        explanationRef,
        sessionId: trusted.sessionId,
      };
};

const feedbackActions = new Set<ContextFeedbackAction>([
  "confirm",
  "helpful",
  "irrelevant",
  "mute_session",
  "revoke",
  "set_scope",
  "stale",
  "wrong",
]);

const scopes = new Set<Scope>([
  "branch",
  "personal",
  "repository",
  "workflow",
]);

const parseFeedbackRequest = (
  input: unknown,
  trusted: TrustedMcpContext,
): ContextFeedbackRequest | undefined => {
  if (
    !isRecord(input) ||
    !hasOnlyKeys(input, [
      "action",
      "reason",
      "requestId",
      "scope",
      "targetId",
    ])
  ) {
    return undefined;
  }
  const action =
    typeof input.action === "string" &&
    feedbackActions.has(input.action as ContextFeedbackAction)
      ? input.action as ContextFeedbackAction
      : undefined;
  const requestId = nonEmptyString(input.requestId);
  const targetId = nonEmptyString(input.targetId);
  const reason = optionalString(input, "reason");
  const scope =
    typeof input.scope === "string" &&
    scopes.has(input.scope as Scope)
      ? input.scope as Scope
      : undefined;
  if (
    action === undefined ||
    requestId === undefined ||
    targetId === undefined ||
    (
      input.reason !== undefined &&
      reason === undefined
    ) ||
    (
      input.scope !== undefined &&
      scope === undefined
    ) ||
    (
      action === "set_scope" &&
      scope === undefined
    ) ||
    (
      action !== "set_scope" &&
      scope !== undefined
    )
  ) {
    return undefined;
  }
  return {
    action,
    ...(reason === undefined
      ? {}
      : {
          reason,
        }),
    requestId,
    ...(scope === undefined
      ? {}
      : {
          scope,
        }),
    sessionId: trusted.sessionId,
    targetId,
  };
};

const tools = [
  {
    description:
      "Return zero to three scoped ProvenLoop guidance items within a hard rendered token budget.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        fileHints: {
          items: {
            type: "string",
          },
          type: "array",
        },
        prompt: {
          type: "string",
        },
        tokenBudget: {
          maximum: MAX_CONTEXT_TOKENS,
          minimum: 1,
          type: "integer",
        },
      },
      required: [
        "prompt",
        "tokenBudget",
      ],
      type: "object",
    },
    name: "provenloop_context",
  },
  {
    description:
      "Explain provenance, applicability, lifecycle state, and contradictions for a previously returned item.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        explanationRef: {
          type: "string",
        },
      },
      required: [
        "explanationRef",
      ],
      type: "object",
    },
    name: "provenloop_explain",
  },
  {
    description:
      "Record one deterministic action for Knowledge returned by a prior ProvenLoop context request.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        action: {
          enum: [
            "helpful",
            "irrelevant",
            "wrong",
            "stale",
            "confirm",
            "revoke",
            "mute_session",
            "set_scope",
          ],
          type: "string",
        },
        reason: {
          type: "string",
        },
        requestId: {
          type: "string",
        },
        scope: {
          enum: [
            "branch",
            "repository",
            "workflow",
            "personal",
          ],
          type: "string",
        },
        targetId: {
          type: "string",
        },
      },
      required: [
        "action",
        "requestId",
        "targetId",
      ],
      type: "object",
    },
    name: "provenloop_feedback",
  },
] as const;

const toolResult = (
  output: Writable,
  id: JsonRpcRequest["id"],
  result: unknown,
): void => {
  respond(output, id, {
    content: [
      {
        text: JSON.stringify(result),
        type: "text",
      },
    ],
    structuredContent: result,
  });
};

const toolError = (
  output: Writable,
  id: JsonRpcRequest["id"],
  error: unknown,
): void => {
  const message = sanitizeDiagnostic(error);
  respond(output, id, {
    content: [
      {
        text: message,
        type: "text",
      },
    ],
    isError: true,
  });
};

const MCP_WRITE_RESERVE_MS = 25;

const withDeadline = async <T>(
  operation: Promise<T>,
  deadline: number,
  message: string,
): Promise<T> => {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new Error(message);
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(message)),
          remaining,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
};

export class LocalMcpToolHandlers implements McpToolHandlers {
  readonly #adapter: CopilotCliAdapter;
  readonly #cwd: string;
  readonly #dataRoot: string;
  readonly #now: () => Date;
  readonly #workflowScopeId: string | undefined;

  public constructor(options: {
    readonly cwd: string;
    readonly dataRoot: string;
    readonly now: () => Date;
    readonly workflowScopeId?: string;
  }) {
    this.#cwd = options.cwd;
    this.#dataRoot = options.dataRoot;
    this.#now = options.now;
    this.#workflowScopeId = options.workflowScopeId;
    this.#adapter = new CopilotCliAdapter({
      dataRoot: options.dataRoot,
      now: options.now,
    });
  }

  public async context(
    request: ContextRequest,
  ): Promise<ContextResponse> {
    const startedAt = Date.now();
    const deadline =
      startedAt + DEFAULT_CONTEXT_TIMEOUT_MS;
    try {
      const state = await this.#state();
      if (!state.capabilities.retrieval.enabled) {
        return {
          items: [],
          latencyMs: Date.now() - startedAt,
          renderedTokens: 0,
          requestId: `context-${randomUUID()}`,
          status: "degraded",
          statusDetail: "Retrieval capability is disabled.",
        };
      }
      const identity = await withDeadline(
        this.#adapter.resolveSession({
          adapterVersion:
            state.detectedCopilotVersion ?? "unknown",
          cwd: request.cwd,
          sessionId: request.sessionId,
        }),
        deadline - MCP_WRITE_RESERVE_MS,
        "Retrieval deadline expired while resolving repository identity.",
      );
      if (identity.internalSession) {
        return {
          items: [],
          latencyMs: Date.now() - startedAt,
          renderedTokens: 0,
          requestId: `context-${randomUUID()}`,
          status: "muted",
          statusDetail:
            "ProvenLoop internal sessions do not receive retrieval context.",
        };
      }
      const paths = resolveWindowsProvenLoopPaths(
        this.#dataRoot,
      );
      const contextLease =
        await new WindowsNamedPipeLeaseProvider(
          await resolveWindowsProvenLoopLeaseName(
            paths.root,
            "knowledge-projection",
          ),
        ).tryAcquire();
      if (contextLease === undefined) {
        throw new Error(
          "Retrieval is unavailable while deletion or projection maintenance is active.",
        );
      }
      try {
        return await this.#withService((service) =>
          service.context({
            ...request,
            now: this.#now(),
            ...(identity.branch === undefined
              ? {}
              : {
                  branch: identity.branch,
                }),
            ...(identity.commitSha === undefined
              ? {}
              : {
                  headSha: identity.commitSha,
                }),
            ...(identity.repositoryId === undefined
              ? {}
              : {
                  repoId: identity.repositoryId,
                }),
          }),
        deadline);
      } finally {
        setImmediate(() => {
          void contextLease.release().catch(() => undefined);
        });
      }
    } catch (error) {
      return {
        items: [],
        latencyMs: Date.now() - startedAt,
        renderedTokens: 0,
        requestId: `context-${randomUUID()}`,
        status: "degraded",
        statusDetail: sanitizeDiagnostic(error),
      };
    }
  }

  public async explain(request: {
    readonly explanationRef: string;
    readonly sessionId: string;
  }): Promise<ContextExplanation> {
    await this.#assertRetrievalEnabled();
    return this.#withKnowledgeLease(() =>
      this.#withService(
        (service) =>
          Promise.resolve(service.explain(request)),
        undefined,
        true,
      ),
    );
  }

  public async feedback(
    request: ContextFeedbackRequest,
  ): Promise<ContextFeedbackResponse> {
    const state = await this.#state();
    if (!state.capabilities.retrieval.enabled) {
      throw new Error(
        "Retrieval capability is disabled.",
      );
    }
    let scopedRequest = request;
    if (request.action === "set_scope") {
      const identity = await this.#adapter.resolveSession({
        adapterVersion:
          state.detectedCopilotVersion ?? "unknown",
        cwd: this.#cwd,
        sessionId: request.sessionId,
      });
      if (identity.internalSession) {
        throw new Error(
          "Internal sessions cannot change Knowledge scope.",
        );
      }
      scopedRequest = {
        ...request,
        ...(identity.branch === undefined
          ? {}
          : {
              branchScopeId: identity.branch,
            }),
        ...(identity.repositoryId === undefined
          ? {}
          : {
              repositoryScopeId: identity.repositoryId,
            }),
        ...(this.#workflowScopeId === undefined
          ? {}
          : {
              workflowScopeId: this.#workflowScopeId,
            }),
      };
    }
    return this.#withKnowledgeLease(() =>
      this.#withService(
        (service) => service.feedback(scopedRequest),
        undefined,
        true,
      ),
    );
  }

  async #withKnowledgeLease<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const paths = resolveWindowsProvenLoopPaths(
      this.#dataRoot,
    );
    const lease = await new WindowsNamedPipeLeaseProvider(
      await resolveWindowsProvenLoopLeaseName(
        paths.root,
        "knowledge-projection",
      ),
    ).tryAcquire();
    if (lease === undefined) {
      throw new Error(
        "Knowledge projection is busy.",
      );
    }
    try {
      return await operation();
    } finally {
      await lease.release();
    }
  }

  async #assertRetrievalEnabled(): Promise<void> {
    const state = await this.#state();
    if (!state.capabilities.retrieval.enabled) {
      throw new Error(
        "Retrieval capability is disabled.",
      );
    }
  }

  async #state() {
    const paths = resolveWindowsProvenLoopPaths(
      this.#dataRoot,
    );
    await assertCopilotAdapterDataRoot(paths);
    return readCopilotAdapterState(
      paths.adapterState,
      this.#now(),
    );
  }

  async #withService<T>(
    operation: (
      service: ContextRetrievalService,
    ) => Promise<T>,
    deadline: number | undefined,
    knowledgeLeaseHeld = false,
  ): Promise<T> {
    const effectiveDeadline =
      deadline ?? Date.now() + DEFAULT_CONTEXT_TIMEOUT_MS;
    const paths = resolveWindowsProvenLoopPaths(
      this.#dataRoot,
    );
    await assertCopilotAdapterDataRoot(paths);
    await Promise.all([
      access(paths.database),
      access(paths.knowledgeDatabase),
    ]);
    const remainingBeforeOpen =
      effectiveDeadline - Date.now();
    if (remainingBeforeOpen <= MCP_WRITE_RESERVE_MS) {
      throw new Error(
        "Retrieval deadline expired before database initialization.",
      );
    }
    const busyTimeoutMs = Math.max(
      1,
      Math.min(
        MCP_WRITE_RESERVE_MS,
        remainingBeforeOpen - MCP_WRITE_RESERVE_MS,
      ),
    );
    const store = new CanonicalSqliteStore(paths.database, {
      busyTimeoutMs,
    });
    let backend: SqliteFtsKnowledgeBackend | undefined;
    try {
      backend = new SqliteFtsKnowledgeBackend(
        paths.knowledgeDatabase,
        {
          busyTimeoutMs,
        },
      );
      const activeBackend = backend;
      const serviceTimeoutMs =
        effectiveDeadline - Date.now() - MCP_WRITE_RESERVE_MS;
      if (serviceTimeoutMs <= 0) {
        throw new Error(
          "Retrieval deadline expired during database initialization.",
        );
      }
      const service = new ContextRetrievalService({
        backend: activeBackend,
        now: this.#now,
        store,
        syncKnowledge: async (candidate) => {
          const syncCurrent = async (): Promise<void> => {
            const current = store.knowledgeCandidates([
              candidate.knowledgeId,
            ])[0];
            if (current === undefined) {
              throw new Error(
                "Knowledge projection target no longer exists.",
              );
            }
            await activeBackend.index([
              knowledgeProjectionFromCandidate(current),
            ]);
          };
          if (knowledgeLeaseHeld) {
            await syncCurrent();
            return;
          }
          const lease = await new WindowsNamedPipeLeaseProvider(
            await resolveWindowsProvenLoopLeaseName(
              paths.root,
              "knowledge-projection",
            ),
          ).tryAcquire();
          if (lease === undefined) {
            throw new Error(
              "Knowledge projection is busy.",
            );
          }
          try {
            await syncCurrent();
          } finally {
            await lease.release();
          }
        },
        timeoutMs: serviceTimeoutMs,
      });
      return await operation(service);
    } finally {
      await backend?.closeAsync();
      store.close();
    }
  }
}

const callTool = async (
  call: ToolCall,
  handlers: McpToolHandlers,
  trusted: TrustedMcpContext,
): Promise<unknown> => {
  switch (call.name) {
    case "provenloop_context": {
      const request = parseContextRequest(
        call.arguments,
        trusted,
      );
      if (request === undefined) {
        throw new TypeError(
          "Invalid provenloop_context arguments.",
        );
      }
      return handlers.context(request);
    }
    case "provenloop_explain": {
      const request = parseExplainRequest(
        call.arguments,
        trusted,
      );
      if (request === undefined) {
        throw new TypeError(
          "Invalid provenloop_explain arguments.",
        );
      }
      return handlers.explain(request);
    }
    case "provenloop_feedback": {
      const request = parseFeedbackRequest(
        call.arguments,
        trusted,
      );
      if (request === undefined) {
        throw new TypeError(
          "Invalid provenloop_feedback arguments.",
        );
      }
      return handlers.feedback(request);
    }
    default:
      throw new Error(`Unknown tool: ${call.name}.`);
  }
};

export const runMcpServer = async (
  io: McpServerIo = {
    input: process.stdin,
    output: process.stdout,
  },
  options: McpServerOptions = {},
): Promise<void> => {
  const trusted: TrustedMcpContext = {
    cwd: options.cwd ?? process.cwd(),
    sessionId:
      options.sessionId ??
      nonEmptyString(process.env.SESSION_ID) ??
      `mcp-process-${process.pid}-${randomUUID()}`,
    ...(options.workflowScopeId === undefined
      ? {}
      : {
          workflowScopeId: options.workflowScopeId,
        }),
  };
  const handlers =
    options.handlers ??
    new LocalMcpToolHandlers({
      cwd: trusted.cwd,
      dataRoot:
        options.dataRoot ??
        resolveWindowsProvenLoopDataRoot(),
      now: options.now ?? (() => new Date()),
      ...(trusted.workflowScopeId === undefined
        ? {}
        : {
            workflowScopeId: trusted.workflowScopeId,
          }),
    });
  const input = createInterface({
    crlfDelay: Infinity,
    input: io.input,
  });
  const pending = new Set<Promise<void>>();
  await new Promise<void>((resolve) => {
    input.on("line", (line) => {
      const handling = (async () => {
        if (line.trim().length === 0) {
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(line) as unknown;
        } catch {
          fail(io.output, null, -32700, "Parse error");
          return;
        }
        const request = asRequest(parsed);
        if (request === undefined) {
          fail(io.output, null, -32600, "Invalid Request");
          return;
        }
        switch (request.method) {
          case "initialize":
            if (request.id !== undefined) {
              respond(io.output, request.id, {
                capabilities: {
                  tools: {},
                },
                protocolVersion: MCP_PROTOCOL_VERSION,
                serverInfo: {
                  name: "provenloop",
                  version: PROVENLOOP_VERSION,
                },
              });
            }
            break;
          case "notifications/initialized":
            break;
          case "ping":
            if (request.id !== undefined) {
              respond(io.output, request.id, {});
            }
            break;
          case "tools/list":
            if (request.id !== undefined) {
              respond(io.output, request.id, {
                tools,
              });
            }
            break;
          case "tools/call": {
            if (request.id === undefined) {
              break;
            }
            const call = asToolCall(request.params);
            if (call === undefined) {
              fail(
                io.output,
                request.id,
                -32602,
                "Invalid tools/call parameters.",
              );
              break;
            }
            try {
              toolResult(
                io.output,
                request.id,
                await callTool(call, handlers, trusted),
              );
            } catch (error) {
              toolError(io.output, request.id, error);
            }
            break;
          }
          default:
            if (request.id !== undefined) {
              fail(
                io.output,
                request.id,
                -32601,
                "Method not found",
              );
            }
        }
      })();
      pending.add(handling);
      void handling.finally(() => {
        pending.delete(handling);
      });
    });
    input.once("close", () => {
      void Promise.all([...pending]).then(() => resolve());
    });
  });
};
