import { describe, expect, it } from "vitest";
import { CopilotEventMapper, type CopilotSessionEvent } from "@provenloop/copilot-adapter";
import { buildLearningWindows, createCaptureEnvelope, learningKnowledgeCandidate, learningSourceDigest, verifyShellRecovery, KnowledgeAdmissionPolicy } from "@provenloop/domain";
import type { CaptureEnvelope, RuleProposal } from "@provenloop/contracts";
import { captureQueueItemSchema } from "@provenloop/contracts";
import { CanonicalSqliteStore } from "@provenloop/storage-sqlite";
import { LearningCoordinator } from "@provenloop/host";

const fixture = (variant = "valid") => {
  const failedCommand = variant === "package-script" ? "npm run test:wrong" : "pnpm test";
  const command = variant === "package-script" ? "npm run test:unit" : "npm test";
  const mapper = new CopilotEventMapper({ adapterVersion: "1.0.84-1", sessionId: "shell-session", copyLimits: { maxStringChars: 16384 },
    workspace: { repoId: "repo", repositoryState: "known_repo", cwd: "C:/repo", worktree: "C:/repo", branch: "main", commitSha: "a".repeat(40) } });
  const native: CopilotSessionEvent[] = [
    { id: "failed-start", parentId: null, type: "tool.execution_start", data: { toolCallId: "failed", toolName: "powershell", arguments: { command: failedCommand, cwd: "C:/repo" }, ...(variant === "mcp" ? { mcpServerName: "remote", mcpToolName: "powershell" } : {}) } },
    { id: "failed-result", parentId: "failed-start", type: "tool.execution_complete", data: { toolCallId: "failed", success: true, result: { content: "Native shell result", contents: [{ type: "shell_exit", shellId: "one", cwd: "C:/repo", exitCode: 1 }] } } },
    { id: "user", parentId: "failed-result", type: "user.message", data: { content: variant === "unquoted-command" ? "Use the repository test command." : `这个仓库用 ${command}，不是 ${failedCommand}，请用 ${command} 重试。` } },
    { id: "turn", parentId: "user", type: "assistant.turn_start", data: { turnId: "turn" } },
    { id: "retry-start", parentId: "turn", type: "tool.execution_start", data: { toolCallId: "retry", toolName: "powershell", arguments: { command, cwd: "C:/repo" }, ...(variant === "mcp" ? { mcpServerName: "remote", mcpToolName: "powershell" } : {}) } },
    { id: "retry-result", parentId: variant === "unrelated" ? "failed-result" : "retry-start", type: "tool.execution_complete", data: { toolCallId: "retry", success: true, result: variant === "text-only" ? { content: "All tests passed" } : { content: "Native shell result", contents: [{ type: "shell_exit", shellId: "two", cwd: variant === "outside" ? "C:/other" : "C:/repo", exitCode: variant === "failed" ? 1 : 0 }] } } },
  ].map((event, i) => ({ ...event, timestamp: new Date(Date.UTC(2026, 8, 8, 0, 0, i)).toISOString() }));
  if (variant === "bridge") {
    const completion = native.at(-1);
    if (!completion) throw new Error("Missing completion");
    native.splice(native.length - 1, 0, { id: "retry-hook", parentId: "retry-start", type: "hook.end", timestamp: "2026-09-08T00:00:04.500Z", data: {} });
    native[native.length - 1] = { ...completion, parentId: "retry-hook" };
  }
  const events: CaptureEnvelope[] = [];
  for (const event of native) {
    const mapped = mapper.map(event);
    if (mapped.status === "ignored" && event.type === "hook.end") continue;
    if (mapped.status !== "mapped") throw new Error(`Fixture native event ${event.type} failed`);
    for (const value of [mapped.value, ...(mapped.additionalEvents ?? [])]) events.push(createCaptureEnvelope(value));
  }
  const find = (source: string, type: string) => { const result = events.find((entry) => entry.sourceEventId === source && entry.event.eventType === type); if (!result) throw new Error("Missing fixture event"); return result; };
  const user = find("user", "prompt.submitted");
  const proposal: RuleProposal = { schemaVersion: 1, proposalId: "shell-proposal", jobId: "shell-job", knowledgeId: "learning-knowledge-shell",
    rule: "Use npm test", trigger: "Test repository", exclusions: ["Other revisions"], createdAt: user.event.timestamp, expiresAt: "2026-10-08T00:00:00Z",
    userSource: { eventId: user.event.eventId, quote: user.content?.message ?? "" }, failedOperationEventId: find("failed-start", "tool.started").event.eventId,
    retryOperationEventId: find("retry-start", "tool.started").event.eventId, completionEventId: find("retry-result", "tool.completed").event.eventId,
    shellPredicate: { kind: "repository_test_command", toolName: "powershell", failedCommand, command },
    sourceDigests: events.map((entry) => ({ eventId: entry.event.eventId, digest: learningSourceDigest(entry) })),
  };
  return { events, proposal };
};

describe("native shell correction learning", () => {
  it("binds derived verification directly while accepting exact legacy copied bridges", () => {
    const { proposal, events } = fixture("bridge");
    const completion = events.find((entry) => entry.event.eventId === proposal.completionEventId);
    const proof = events.find((entry) => entry.event.eventType === "test.completed" && entry.event.operationId === completion?.event.operationId);
    if (!completion || !proof) throw new Error("Missing native proof");
    expect(completion.event.parentBridge).toHaveLength(1);
    expect(proof.event.parentBridge).toBeUndefined();
    expect(verifyShellRecovery(proposal, events, new Date())).toBeDefined();
    const legacy = events.map((entry) => entry === proof ? { ...entry, event: { ...entry.event, parentBridge: completion.event.parentBridge, originalParentSourceEventId: completion.event.originalParentSourceEventId } } : entry);
    const legacyProposal = { ...proposal, sourceDigests: legacy.map((entry) => ({ eventId: entry.event.eventId, digest: learningSourceDigest(entry) })) };
    expect(verifyShellRecovery(legacyProposal, legacy, new Date())).toBeDefined();
    const altered = legacy.map((entry) => entry.event.eventId === proof.event.eventId ? { ...entry, event: { ...entry.event, originalParentSourceEventId: "unrelated-native-parent" } } : entry);
    expect(verifyShellRecovery({ ...proposal, sourceDigests: altered.map((entry) => ({ eventId: entry.event.eventId, digest: learningSourceDigest(entry) })) }, altered, new Date())).toBeUndefined();
  });
  it("persists native-derived shell qualification through the coordinator and purges its receipt with source deletion", async () => {
    const { events, proposal } = fixture("package-script");
    const store = new CanonicalSqliteStore(":memory:");
    try {
      for (const [index, envelope] of events.entries()) store.ingestQueueItem(captureQueueItemSchema.parse({ schemaVersion: 1, queueItemId: `shell-${index}`, state: "pending", attemptCount: 0, failureCount: 0, createdAt: envelope.event.timestamp, updatedAt: envelope.event.timestamp, envelope }));
      const coordinator = new LearningCoordinator({ store, enabled: async () => true, now: () => new Date("2026-09-08T00:00:10Z"),
        lease: { tryAcquire: async () => ({ release: async () => undefined }) }, provider: { identity: { provider: "fixture", model: "fixture", version: "1" }, infer: async () => ({ schemaVersion: 1, proposals: [{
          rule: proposal.rule, trigger: proposal.trigger, exclusions: proposal.exclusions, userSource: proposal.userSource,
          failedOperationEventId: proposal.failedOperationEventId, retryOperationEventId: proposal.retryOperationEventId, completionEventId: proposal.completionEventId, shellPredicate: proposal.shellPredicate,
        }] }) } });
      expect(await coordinator.run()).toMatchObject({ status: "evaluated", qualified: 1 });
      const candidate = store.knowledgeCandidates()[0];
      if (!candidate) throw new Error("Missing qualified shell rule");
      expect(new KnowledgeAdmissionPolicy().evaluate({ candidate, ...store.knowledgeAdmissionEvidence([candidate]) }).admitted).toBe(true);
      expect(store.learningReceipts()).toEqual([expect.objectContaining({ proves: "repository_test_command" })]);
      const target = { targetType: "source" as const, targetId: proposal.userSource.eventId };
      const deletion = store.beginDeletion(target); store.deleteCanonicalTarget(deletion.deletionId, target);
      expect(store.knowledgeCandidates()).toEqual([]); expect(store.learningReceipts()).toEqual([]); expect(store.learningJobs()).toEqual([]);
    } finally { store.close(); }
  });
  it("uses native package-script exit evidence for a corrected test:unit invocation", () => {
    const { proposal, events } = fixture("package-script");
    expect(verifyShellRecovery(proposal, events, new Date())).toMatchObject({ proves: "repository_test_command", predicate: { failedCommand: "npm run test:wrong", command: "npm run test:unit" } });
  });
  it("qualifies an ordinary correction from native shell exits without rewriting its trust", () => {
    const { events, proposal } = fixture();
    const now = new Date("2026-09-08T00:00:10Z");
    const receipt = verifyShellRecovery(proposal, events, now);
    expect(receipt).toMatchObject({ proves: "repository_test_command", commitSha: "a".repeat(40), predicate: { command: "npm test" } });
    expect(events.filter((entry) => entry.event.eventType === "user.corrected")).toEqual([]);
    const window = buildLearningWindows(events, now)[0];
    expect(window?.events.some((entry) => entry.event.eventType === "test.completed" && entry.event.exitCode === 0)).toBe(true);
    if (!window || !receipt) throw new Error("Expected a verified window");
    const candidate = learningKnowledgeCandidate(window, proposal, receipt);
    expect(candidate).toMatchObject({ state: "active", evidenceTier: "externally_verified" });
    expect(new KnowledgeAdmissionPolicy().evaluate({ candidate, envelopes: events, correctionKeys: [], correctionSourceEventIds: new Set(), workEpisodes: [], learningProposals: [proposal], learningReceipts: [receipt] }).admitted).toBe(true);
  });
  it.each(["failed", "text-only", "mcp", "outside", "unrelated", "unquoted-command"])("does not qualify %s evidence", (variant) => {
    const { events, proposal } = fixture(variant);
    expect(verifyShellRecovery(proposal, events, new Date())).toBeUndefined();
  });
  it("rejects injected command expressions, changed revision and omitted native evidence", () => {
    const { events, proposal } = fixture();
    if (!proposal.shellPredicate) throw new Error("Missing shell predicate");
    for (const command of ["npm test && publish", "npm run deploy", "npm test --ignore-scripts"]) {
      expect(verifyShellRecovery({ ...proposal, shellPredicate: { ...proposal.shellPredicate, command } }, events, new Date())).toBeUndefined();
    }
    const changed = events.map((entry) => entry.event.eventId === proposal.completionEventId ? { ...entry, event: { ...entry.event, commitSha: "b".repeat(40) } } : entry);
    expect(verifyShellRecovery({ ...proposal, sourceDigests: changed.map((entry) => ({ eventId: entry.event.eventId, digest: learningSourceDigest(entry) })) }, changed, new Date())).toBeUndefined();
    expect(verifyShellRecovery({ ...proposal, sourceDigests: proposal.sourceDigests.filter((source) => !events.find((entry) => entry.event.eventId === source.eventId && entry.event.eventType === "test.completed")) }, events, new Date())).toBeUndefined();
  });
});
