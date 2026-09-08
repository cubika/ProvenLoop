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
  readInternalSessionIds,
  readTrustedSessionContext,
  type TrustedSessionContext,
} from "@provenloop/copilot-adapter";
import {
  PROVENLOOP_VERSION,
  CURRENT_SCHEMA_VERSION,
  type Scope,
  type SessionIdentity,
} from "@provenloop/contracts";
import {
  sanitizeDiagnostic,
  sha256,
  isProvenLoopInternalEnvironment,
} from "@provenloop/domain";
import {
  isUpgradeMaintenanceActive,
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
import { PROVENLOOP_CODE_VERSION } from "./release-metadata.js";

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
  unavailableContext?(
    request: ContextRequest,
    detail: string,
  ): Promise<ContextResponse>;
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
  readonly resolveTrustedContext?: () => Promise<TrustedMcpContext | undefined>;
}

export type TrustedMcpContext = TrustedSessionContext;

const trustedWorkspace = (
  context: TrustedMcpContext,
): NonNullable<ContextRequest["trustedWorkspace"]> => ({
  repositoryState: context.repositoryState,
  repositoryObservedAt: context.repositoryObservedAt,
  ...(context.repositoryState !== "known_repo" ? {} : {
    ...(context.repositoryId === undefined ? {} : { repositoryId: context.repositoryId }),
    ...(context.branch === undefined ? {} : { branch: context.branch }),
    ...(context.commitSha === undefined ? {} : { commitSha: context.commitSha }),
  }),
});

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
    trustedWorkspace: trustedWorkspace(trusted),
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
      "resolvesEvidenceIds",
      "scope",
      "targetId",
      "targetRef",
      "userReportedApplied",
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
  const resolvesEvidenceIds = stringList(input.resolvesEvidenceIds);
  const targetRef = input.targetRef;
  const targetKind = isRecord(targetRef) &&
    hasOnlyKeys(targetRef, ["kind", "id"]) &&
    (targetRef.kind === "knowledge" || targetRef.kind === "branch_context")
    ? targetRef.kind
    : undefined;
  const targetId = targetKind === undefined
    ? nonEmptyString(input.targetId)
    : nonEmptyString((targetRef as Readonly<Record<string, unknown>>).id);
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
    (input.resolvesEvidenceIds !== undefined && (
      resolvesEvidenceIds === undefined || action !== "confirm"
    )) ||
    (input.targetRef !== undefined && targetKind === undefined) ||
    (input.targetRef !== undefined && input.targetId !== undefined) ||
    (input.userReportedApplied !== undefined &&
      typeof input.userReportedApplied !== "boolean") ||
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
    cwd: trusted.cwd,
    ...(reason === undefined
      ? {}
      : {
          reason,
        }),
    requestId,
    ...(resolvesEvidenceIds === undefined ? {} : {
      resolvesEvidenceIds: [...new Set(resolvesEvidenceIds)].sort(),
    }),
    ...(scope === undefined
      ? {}
      : {
          scope,
        }),
    sessionId: trusted.sessionId,
    targetId,
    trustedWorkspace: trustedWorkspace(trusted),
    ...(targetKind === undefined ? {} : { targetKind }),
    ...(trusted.workflowScopeId === undefined ? {} : {
      workflowScopeId: trusted.workflowScopeId,
    }),
    ...(input.userReportedApplied === undefined ? {} : {
      userReportedApplied: input.userReportedApplied as boolean,
    }),
  };
};

const tools = [
  {
    description:
      "At the start of a new coding task or a resumed task, retrieve scoped local guidance once. Do not repeat unchanged guidance for every turn. Returns at most three items within an estimated rendered token budget.",
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
      "Propose feedback on previously returned Knowledge or Branch Context. Persistent feedback requires the real user's exact approval of the returned confirmation code; never approve on the user's behalf.",
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
        resolvesEvidenceIds: {
          description: "For explicit confirmation only: the counterevidence IDs the user has reviewed and is resolving. Ordinary confirmation does not clear other or newer counterevidence.",
          items: { type: "string" },
          type: "array",
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
        targetRef: {
          additionalProperties: false,
          properties: {
            kind: { enum: ["knowledge", "branch_context"], type: "string" },
            id: { type: "string" },
          },
          required: ["kind", "id"],
          type: "object",
        },
        userReportedApplied: {
          description: "True only if the user explicitly reports actually applying this item; helpful alone does not mean applied.",
          type: "boolean",
        },
      },
      required: [
        "action",
        "requestId",
      ],
      oneOf: [
        { required: ["targetRef"] },
        { required: ["targetId"] },
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
      await this.#assertNotUpgrading();
      const state = await this.#state();
      if (await this.#isInternalSession(request.sessionId)) {
        return {
          items: [],
          latencyMs: Date.now() - startedAt,
          renderedTokens: 0,
          requestId: `context-${randomUUID()}`,
          status: "muted",
          statusDetail: "ProvenLoop internal sessions do not receive retrieval context.",
        };
      }
      if (!state.capabilities.retrieval.enabled) {
        const requestId = `context-${randomUUID()}`;
        let recorded = false;
        let store: CanonicalSqliteStore | undefined;
        let observationLease: Awaited<ReturnType<WindowsNamedPipeLeaseProvider["tryAcquire"]>>;
        try {
          const paths = resolveWindowsProvenLoopPaths(this.#dataRoot);
          observationLease = await this.#acquireKnowledgeLease();
          await access(paths.database);
          store = new CanonicalSqliteStore(paths.database, {
            busyTimeoutMs: MCP_WRITE_RESERVE_MS,
          });
          recorded = store.appendContextUseRecord({
            schemaVersion: CURRENT_SCHEMA_VERSION,
            appliedKnowledgeIds: [],
            candidateKnowledgeIds: [],
            codeVersion: PROVENLOOP_CODE_VERSION,
            createdAt: this.#now().toISOString(),
            latencyMs: Date.now() - startedAt,
            renderedTokens: 0,
            requestId,
            retrievalStatus: "disabled",
            returnedKnowledgeIds: [],
            sessionId: request.sessionId,
            ...(request.trustedWorkspace?.repositoryState !== "known_repo" ? {} : {
              ...(request.trustedWorkspace.repositoryId === undefined ? {} : {
                repoId: request.trustedWorkspace.repositoryId,
              }),
              ...(request.trustedWorkspace.branch === undefined ? {} : {
                branch: request.trustedWorkspace.branch,
              }),
            }),
          });
        } catch {
          recorded = false;
        } finally {
          try { store?.close(); } finally { await observationLease?.release(); }
        }
        return {
          items: [],
          latencyMs: Date.now() - startedAt,
          renderedTokens: 0,
          requestId,
          status: "degraded",
          statusDetail: recorded
            ? "Retrieval capability is disabled."
            : "Retrieval capability is disabled; its observation could not be persisted.",
        };
      }
      const identity = await withDeadline(
        this.#resolveSessionIdentity(
          request,
          state.detectedCopilotVersion ?? "unknown",
        ),
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
      const contextLease = await this.#acquireKnowledgeLease();
      try {
        const {
          repoId: suppliedRepositoryId,
          branch: suppliedBranch,
          headSha: suppliedHead,
          ...unscopedRequest
        } = request;
        void suppliedRepositoryId;
        void suppliedBranch;
        void suppliedHead;
        return await this.#withService((service) =>
          service.context({
            ...unscopedRequest,
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
        await contextLease.release();
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

  public async unavailableContext(
    request: ContextRequest,
    detail: string,
  ): Promise<ContextResponse> {
    const startedAt = Date.now();
    const requestId = `context-${randomUUID()}`;
    let store: CanonicalSqliteStore | undefined;
    let observationLease: Awaited<ReturnType<WindowsNamedPipeLeaseProvider["tryAcquire"]>>;
    let statusDetail = detail;
    try {
      await this.#assertNotUpgrading();
      const paths = resolveWindowsProvenLoopPaths(this.#dataRoot);
      await assertCopilotAdapterDataRoot(paths);
      if (await this.#isInternalSession(request.sessionId)) {
        return {
          items: [],
          latencyMs: Date.now() - startedAt,
          renderedTokens: 0,
          requestId,
          status: "muted",
          statusDetail: "ProvenLoop internal sessions do not receive retrieval context.",
        };
      }
      observationLease = await this.#acquireKnowledgeLease();
      await access(paths.database);
      store = new CanonicalSqliteStore(paths.database, { busyTimeoutMs: MCP_WRITE_RESERVE_MS });
      store.appendContextUseRecord({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        appliedKnowledgeIds: [],
        candidateKnowledgeIds: [],
        codeVersion: PROVENLOOP_CODE_VERSION,
        createdAt: this.#now().toISOString(),
        latencyMs: Date.now() - startedAt,
        renderedTokens: 0,
        requestId,
        retrievalStatus: "degraded",
        returnedKnowledgeIds: [],
        sessionId: request.sessionId,
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("upgrade maintenance")) statusDetail = error.message;
      // An unavailable canonical store must not turn a degraded read into a successful one.
    } finally {
      try { store?.close(); } finally { await observationLease?.release(); }
    }
    return {
      items: [],
      latencyMs: Date.now() - startedAt,
      renderedTokens: 0,
      requestId,
      status: "degraded",
      statusDetail,
    };
  }

  public async explain(request: {
    readonly explanationRef: string;
    readonly sessionId: string;
  }): Promise<ContextExplanation> {
    await this.#assertNotUpgrading();
    await this.#assertRetrievalEnabled();
    if (await this.#isInternalSession(request.sessionId)) {
      throw new Error("Internal sessions cannot inspect user context.");
    }
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
    await this.#assertNotUpgrading();
    const state = await this.#state();
    if (!state.capabilities.retrieval.enabled) {
      throw new Error(
        "Retrieval capability is disabled.",
      );
    }
    if (await this.#isInternalSession(request.sessionId)) {
      throw new Error("Internal sessions cannot submit user feedback.");
    }
    let scopedRequest = request;
    if (request.action === "set_scope") {
      const identity = await this.#resolveSessionIdentity({
        cwd: request.cwd ?? this.#cwd,
        sessionId: request.sessionId,
        ...(request.trustedWorkspace === undefined ? {} : {
          trustedWorkspace: request.trustedWorkspace,
        }),
      }, state.detectedCopilotVersion ?? "unknown");
      if (identity.internalSession) {
        throw new Error(
          "Internal sessions cannot change Knowledge scope.",
        );
      }
      const workflowScopeId = request.workflowScopeId ?? this.#workflowScopeId;
      const {
        branchScopeId: suppliedBranch,
        repositoryScopeId: suppliedRepository,
        ...withoutScope
      } = request;
      void suppliedBranch;
      void suppliedRepository;
      scopedRequest = {
        ...withoutScope,
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
        ...(workflowScopeId === undefined
          ? {}
          : {
              workflowScopeId,
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

  async #isInternalSession(sessionId: string): Promise<boolean> {
    const paths = resolveWindowsProvenLoopPaths(this.#dataRoot);
    return isProvenLoopInternalEnvironment(process.env) ||
      (await readInternalSessionIds(paths.internalSessions)).has(sessionId.trim());
  }

  async #resolveSessionIdentity(
    request: Pick<ContextRequest, "cwd" | "sessionId" | "trustedWorkspace">,
    adapterVersion: string,
  ): Promise<SessionIdentity> {
    const snapshot = request.trustedWorkspace;
    if (snapshot === undefined) {
      return this.#adapter.resolveSession({
        adapterVersion,
        cwd: request.cwd,
        sessionId: request.sessionId,
      });
    }
    const observedAt = Date.parse(snapshot.repositoryObservedAt);
    const repositoryId = nonEmptyString(snapshot.repositoryId);
    if (
      (snapshot.repositoryState !== "known_repo" &&
        snapshot.repositoryState !== "known_outside_repo") ||
      !Number.isFinite(observedAt) ||
      Date.now() - observedAt > 60_000 ||
      observedAt > Date.now() + 5_000 ||
      (snapshot.repositoryState === "known_repo" &&
        repositoryId === undefined)
    ) {
      throw new Error("Trusted repository identity is unknown, refreshing, or stale.");
    }
    return {
      internalSession: await this.#isInternalSession(request.sessionId),
      sessionId: request.sessionId,
      ...(snapshot.repositoryState !== "known_repo" || repositoryId === undefined ? {} : {
        repositoryId,
        ...(snapshot.branch === undefined ? {} : { branch: snapshot.branch }),
        ...(snapshot.commitSha === undefined ? {} : { commitSha: snapshot.commitSha }),
      }),
    };
  }

  async #withKnowledgeLease<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const lease = await this.#acquireKnowledgeLease();
    try { return await operation(); } finally { await lease.release(); }
  }

  async #assertNotUpgrading(): Promise<void> {
    if (await isUpgradeMaintenanceActive(this.#dataRoot)) {
      throw new Error("ProvenLoop upgrade maintenance is in progress; retry after it finishes.");
    }
  }

  async #acquireKnowledgeLease() {
    await this.#assertNotUpgrading();
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
      await this.#assertNotUpgrading();
      return lease;
    } catch (error) {
      await lease.release();
      throw error;
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
        codeVersion: PROVENLOOP_CODE_VERSION,
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
      try { await backend?.closeAsync(); } finally { store.close(); }
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
      const approvalCode = `PL-${sha256({
        action: request.action,
        cwd: trusted.cwd,
        reason: request.reason,
        requestId: request.requestId,
        resolvesEvidenceIds: request.resolvesEvidenceIds,
        scope: request.scope,
        sessionId: trusted.sessionId,
        targetId: request.targetId,
        targetKind: request.targetKind ?? "knowledge",
        userReportedApplied: request.userReportedApplied === true,
        workspaceVersion: trusted.workspaceVersion,
      }).slice(0, 12)}`;
      const approval = trusted.latestUserMessage;
      const approvedText = approval?.text.trim();
      if (
        approval === undefined ||
        approval.eventId.trim().length === 0 ||
        !Number.isFinite(Date.parse(approval.timestamp)) ||
        Date.now() - Date.parse(approval.timestamp) > 5 * 60_000 ||
        Date.parse(approval.timestamp) > Date.now() + 5_000 ||
        (approvedText !== `确认 ${approvalCode}` &&
          approvedText !== `confirm ${approvalCode}`)
      ) {
        return {
          action: request.action,
          confirmationCode: approvalCode,
          requestId: request.requestId,
          message: `Proposed ${request.action} for ${request.targetKind ?? "knowledge"}:${request.targetId}; user-reported application: ${request.userReportedApplied === true}. Ask the user to approve by replying exactly: 确认 ${approvalCode}`,
          ...(request.reason === undefined ? {} : { reason: request.reason }),
          ...(request.resolvesEvidenceIds === undefined ? {} : {
            resolvesEvidenceIds: request.resolvesEvidenceIds,
          }),
          ...(request.scope === undefined ? {} : { scope: request.scope }),
          status: "confirmation_required",
          targetRef: {
            kind: request.targetKind ?? "knowledge",
            id: request.targetId,
          },
          userReportedApplied: request.userReportedApplied === true,
        };
      }
      return handlers.feedback({
        ...request,
        evidenceRef: approval.eventId,
        source: "user",
      });
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
  const root = options.dataRoot ?? resolveWindowsProvenLoopDataRoot();
  const sessionId = options.sessionId ?? nonEmptyString(process.env.SESSION_ID);
  const resolveTrustedContext = options.resolveTrustedContext ?? (async () => {
    if (sessionId === undefined) {
      return undefined;
    }
    return readTrustedSessionContext(root, sessionId);
  });
  const handlers =
    options.handlers ??
    new LocalMcpToolHandlers({
      cwd: options.cwd ?? process.cwd(),
      dataRoot: root,
      now: options.now ?? (() => new Date()),
      ...(options.workflowScopeId === undefined
        ? {}
        : {
            workflowScopeId: options.workflowScopeId,
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
                instructions:
                  "For a new coding task or resumed task, call provenloop_context once before substantive work with relevant fileHints and tokenBudget 600. Do not repeatedly inject unchanged guidance. Treat unavailable identity or empty results honestly. Persistent feedback requires the real user's exact approval of the server's confirmation code; never approve on the user's behalf. User-confirmed rules are not externally verified knowledge, and displayed or helpful context is not automatically applied or a verified outcome.",
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
              const trusted = await resolveTrustedContext();
              if (
                trusted === undefined ||
                (trusted.repositoryState !== "known_repo" &&
                  trusted.repositoryState !== "known_outside_repo")
              ) {
                if (call.name === "provenloop_context") {
                  const contextRequest = trusted === undefined
                    ? undefined
                    : parseContextRequest(call.arguments, trusted);
                  if (
                    contextRequest !== undefined &&
                    handlers.unavailableContext !== undefined
                  ) {
                    toolResult(
                      io.output,
                      request.id,
                      await handlers.unavailableContext(
                        contextRequest,
                        "Trusted repository identity is unknown or being refreshed. No context was retrieved.",
                      ),
                    );
                    break;
                  }
                  toolResult(io.output, request.id, {
                    items: [],
                    latencyMs: 0,
                    renderedTokens: 0,
                    requestId: `context-${randomUUID()}`,
                    status: "degraded",
                    statusDetail: "Trusted session/workspace identity is unavailable or being refreshed. No context was retrieved.",
                  });
                  break;
                }
                throw new Error("Trusted session/workspace identity is unavailable.");
              }
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
