import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  runMcpServer,
  type McpToolHandlers,
} from "@provenloop/cli";

const handlers = (): McpToolHandlers => ({
  context: vi.fn<McpToolHandlers["context"]>(async () => ({
    items: [],
    latencyMs: 0,
    renderedTokens: 0,
    requestId: "request-1",
    status: "ok",
  })),
  explain: vi.fn<McpToolHandlers["explain"]>(async (request) => ({
    explanationRef: request.explanationRef,
    status: "not_found",
  })),
  feedback: vi.fn<McpToolHandlers["feedback"]>(async () => ({ status: "recorded" })),
});

const call = async (
  name: string,
  args: Readonly<Record<string, unknown>>,
  options: NonNullable<Parameters<typeof runMcpServer>[1]>,
) => {
  const input = new PassThrough();
  const output = new PassThrough();
  let content = "";
  output.on("data", (chunk: Buffer) => {
    content += chunk.toString("utf8");
  });
  const running = runMcpServer({ input, output }, options);
  input.end(`${JSON.stringify({
    id: 1,
    jsonrpc: "2.0",
    method: "tools/call",
    params: { name, arguments: args },
  })}\n`);
  await running;
  return JSON.parse(content).result;
};

describe("trusted MCP session and write intent", () => {
  it("degrades rather than inventing a session identity", async () => {
    const tools = handlers();
    const result = await call("provenloop_context", {
      prompt: "Run tests",
      tokenBudget: 600,
    }, {
      handlers: tools,
      resolveTrustedContext: async () => undefined,
    });
    expect(result.structuredContent).toMatchObject({
      status: "degraded",
      items: [],
    });
    expect(tools.context).not.toHaveBeenCalled();
  });

  it("resolves the current workspace for each request", async () => {
    const tools = handlers();
    let cwd = "C:\\repo-one";
    const options = {
      handlers: tools,
      resolveTrustedContext: async () => ({
        cwd,
        sessionId: "sdk-session",
        workspaceVersion: cwd,
        repositoryState: "known_outside_repo" as const,
        repositoryObservedAt: new Date().toISOString(),
      }),
    };
    await call("provenloop_context", {
      prompt: "Run tests",
      tokenBudget: 600,
    }, options);
    cwd = "C:\\repo-two";
    await call("provenloop_context", {
      prompt: "Run tests",
      tokenBudget: 600,
    }, options);
    expect(tools.context).toHaveBeenNthCalledWith(1, expect.objectContaining({
      cwd: "C:\\repo-one",
      sessionId: "sdk-session",
    }));
    expect(tools.context).toHaveBeenNthCalledWith(2, expect.objectContaining({
      cwd: "C:\\repo-two",
      sessionId: "sdk-session",
    }));
  });

  it("requires a real user message approving the exact feedback operation", async () => {
    const tools = handlers();
    const args = {
      action: "helpful",
      requestId: "request-1",
      targetRef: { kind: "branch_context", id: "branch-1" },
      userReportedApplied: true,
    };
    const context = {
      cwd: "C:\\repo-one",
      sessionId: "sdk-session",
      workspaceVersion: "workspace-1",
      repositoryState: "known_outside_repo" as const,
      repositoryObservedAt: new Date().toISOString(),
    };
    const proposed = await call("provenloop_feedback", args, {
      handlers: tools,
      resolveTrustedContext: async () => context,
    });
    expect(proposed.structuredContent.status).toBe("confirmation_required");
    expect(tools.feedback).not.toHaveBeenCalled();
    const confirmationCode = proposed.structuredContent.confirmationCode;
    const approvedContext = {
      ...context,
      latestUserMessage: {
        eventId: "real-user-event",
        text: `确认 ${confirmationCode}`,
        timestamp: new Date().toISOString(),
      },
    };
    const stale = await call("provenloop_feedback", args, {
      handlers: tools,
      resolveTrustedContext: async () => ({
        ...approvedContext,
        latestUserMessage: {
          ...approvedContext.latestUserMessage,
          timestamp: new Date(Date.now() - 10 * 60_000).toISOString(),
        },
      }),
    });
    expect(stale.structuredContent.status).toBe("confirmation_required");
    const moved = await call("provenloop_feedback", args, {
      handlers: tools,
      resolveTrustedContext: async () => ({
        ...approvedContext,
        cwd: "C:\\repo-two",
        workspaceVersion: "workspace-2",
      }),
    });
    expect(moved.structuredContent.status).toBe("confirmation_required");
    expect(tools.feedback).not.toHaveBeenCalled();
    const changed = await call("provenloop_feedback", {
      ...args,
      action: "wrong",
    }, {
      handlers: tools,
      resolveTrustedContext: async () => approvedContext,
    });
    expect(changed.structuredContent.status).toBe("confirmation_required");
    expect(tools.feedback).not.toHaveBeenCalled();
    await call("provenloop_feedback", args, {
      handlers: tools,
      resolveTrustedContext: async () => approvedContext,
    });
    expect(tools.feedback).toHaveBeenCalledWith(expect.objectContaining({
      targetKind: "branch_context",
      targetId: "branch-1",
      source: "user",
      evidenceRef: "real-user-event",
      userReportedApplied: true,
    }));
  });

  it("rejects model-supplied approval provenance", async () => {
    const tools = handlers();
    const result = await call("provenloop_feedback", {
      action: "helpful",
      requestId: "request-1",
      targetId: "knowledge-1",
      source: "user",
      evidenceRef: "invented",
    }, {
      handlers: tools,
      resolveTrustedContext: async () => ({
        cwd: "C:\\repo",
        sessionId: "sdk-session",
        workspaceVersion: "workspace-1",
        repositoryState: "known_outside_repo" as const,
        repositoryObservedAt: new Date().toISOString(),
      }),
    });
    expect(result.isError).toBe(true);
    expect(tools.feedback).not.toHaveBeenCalled();
  });
});
