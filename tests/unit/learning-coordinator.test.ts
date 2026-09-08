import { describe, expect, it } from "vitest";
import { captureQueueItemSchema } from "@provenloop/contracts";
import { createCaptureEnvelope, redactCaptureEnvelopeForPersistence, sha256, buildLearningWindows, type CaptureEventInput } from "@provenloop/domain";
import { LearningCoordinator } from "@provenloop/host";
import { CanonicalSqliteStore } from "@provenloop/storage-sqlite";

const base = Date.parse("2026-09-07T00:00:00.000Z");
const now = () => new Date(base + 10_000);
const fixture = () => {
  const store = new CanonicalSqliteStore(":memory:");
  const events = [
    { id: "fail-start", type: "tool.started", trust: "tool" as const },
    { id: "fail-result", type: "tool.failed", trust: "tool" as const },
    { id: "user", type: "prompt.submitted", trust: "user" as const, message: "这个工具需要 path 参数，请补上再试。" },
    { id: "retry", type: "tool.started", trust: "tool" as const },
    { id: "result", type: "tool.completed", trust: "tool" as const },
  ];
  for (const [index, event] of events.entries()) {
    const timestamp = new Date(base + index * 1_000).toISOString();
    const envelope = redactCaptureEnvelopeForPersistence(createCaptureEnvelope({
      adapter: "copilot-cli", adapterVersion: "1.0.84-1", sourceEventId: event.id,
      sessionId: "session", repoId: "repo", worktree: "C:\repo", repositoryState: "known_repo",
      eventType: event.type, timestamp, trust: event.trust, ...(event.message ? { content: { message: event.message } } : {}),
    })).envelope;
    store.ingestQueueItem(captureQueueItemSchema.parse({ schemaVersion: 1, queueItemId: `queue-${index}`, state: "pending", attemptCount: 0, failureCount: 0, createdAt: timestamp, updatedAt: timestamp, envelope }));
  }
  const captured = store.episodeSourceEnvelopes();
  let calls = 0;
  const provider = { identity: { provider: "test", model: "test", version: "1" }, infer: async () => {
    calls += 1;
    return { schemaVersion: 1, proposals: [{ rule: "Supply the path argument.", trigger: "Call the path tool", exclusions: ["Other tools"],
      userSource: { eventId: captured[2]?.event.eventId, quote: "需要 path 参数" },
      failedOperationEventId: captured[0]?.event.eventId, retryOperationEventId: captured[3]?.event.eventId, completionEventId: captured[4]?.event.eventId }] };
  } };
  const options = { store, provider, lease: { tryAcquire: async () => ({ release: async () => undefined }) }, enabled: async () => true, now };
  return { store, options, calls: () => calls, captured };
};

describe("automatic learning coordinator", () => {
  it("retains the inference lease until cancelled provider cleanup settles", async () => {
    const f=fixture();const stopped=new AbortController();let release=false;let finish:()=>void=()=>undefined;let started:()=>void=()=>undefined;
    const entered=new Promise<void>((resolve)=>{started=resolve;});
    try {
      const running=new LearningCoordinator({...f.options,signal:stopped.signal,lease:{tryAcquire:async()=>({release:async()=>{release=true;}})},provider:{...f.options.provider,infer:async()=>{started();await new Promise<void>((resolve)=>{finish=resolve;});return {schemaVersion:1,proposals:[]};}}}).run();
      await entered;stopped.abort();await new Promise<void>((resolve)=>setImmediate(resolve));expect(release).toBe(false);
      finish();expect(await running).toMatchObject({status:"cancelled"});expect(release).toBe(true);
    } finally {f.store.close();}
  });
  it("cancels a running provider on host shutdown without committing its response", async () => {
    const f = fixture();
    const stopped = new AbortController();
    let aborted = false;
    try {
      const coordinator = new LearningCoordinator({ ...f.options, signal: stopped.signal, provider: { ...f.options.provider, infer: async (_window, options) => {
        options.signal.addEventListener("abort", () => { aborted = true; }, { once: true });
        stopped.abort();
        return f.options.provider.infer();
      } } });
      expect(await coordinator.run()).toMatchObject({ status: "cancelled" });
      expect(aborted).toBe(true);
      expect(f.store.learningJobs()[0]?.state).toBe("cancelled");
      expect(f.store.learningProposals()).toEqual([]);
      expect(f.store.knowledgeCandidates()).toEqual([]);
      expect((await coordinator.run()).status).toBe("disabled");
      expect(f.calls()).toBe(1);
    } finally { f.store.close(); }
  });
  it("bounds correction windows to the actual failed operation and retry completion", () => {
    const f = fixture();
    try {
      const source = f.captured[0];
      const completion = f.captured[4];
      if (!source || !completion) throw new Error("Missing fixture sources.");
      const relevant = f.captured.map((entry, index) => index <= 1 ? { ...entry, event: { ...entry.event, operationId: "failed-operation" } } : entry);
      const earlier = { ...source, sourceEventId: "unrelated-user", event: { ...source.event, eventId: "earlier-user", eventType: "prompt.submitted", trust: "user" as const, timestamp: new Date(base - 1000).toISOString() }, content: { message: "A separate request" } };
      const tail = { ...completion, sourceEventId: "tail", event: { ...completion.event, eventId: "tail", eventType: "agent.message", trust: "model" as const, timestamp: new Date(base + 5000).toISOString() }, content: { message: "Large unrelated response ".repeat(2000) } };
      const windows = buildLearningWindows([earlier, ...relevant, tail], now());
      const selected = windows.find((window) => window.createdAt === f.captured[2]?.event.timestamp);
      expect(selected?.events.map((entry) => entry.event.eventId)).toEqual(relevant.map((entry) => entry.event.eventId));
      expect(Buffer.byteLength(JSON.stringify(selected))).toBeLessThan(30 * 1024);
    } finally { f.store.close(); }
  });
  it("purges sibling derived rules when deleting their shared learning job", async () => {
    const f = fixture();
    try {
      const infer = f.options.provider.infer;
      await new LearningCoordinator({ ...f.options, provider: { ...f.options.provider, infer: async () => {
        const response = await infer();
        const first = response.proposals[0];
        if (!first) throw new Error("Missing fixture proposal.");
        return { ...response, proposals: [first, { ...first, rule: "Check the file path before calling.", trigger: "Read another file" }] };
      } } }).run();
      const candidates = f.store.knowledgeCandidates();
      expect(candidates).toHaveLength(2);
      const target = { targetType: "knowledge" as const, targetId: candidates[0]?.knowledgeId ?? "missing" };
      const deletion = f.store.beginDeletion(target);
      const removed = f.store.deleteCanonicalTarget(deletion.deletionId, target);
      expect(f.store.learningJobs()).toEqual([]);
      expect(f.store.learningProposals()).toEqual([]);
      expect(f.store.knowledgeCandidates()).toEqual([]);
      expect(removed.dependentIds).toEqual(expect.arrayContaining(candidates.map((candidate) => `knowledge:${candidate.knowledgeId}`)));
      expect(f.store.rawEvents()).toHaveLength(5);
    } finally { f.store.close(); }
  });
  it.each(["late_contract", "archived", "expired", "deleted", "revoked"] as const)("reevaluates without inference and respects %s", async (scenario) => {
    const store = new CanonicalSqliteStore(":memory:");
    const contractBody = { schemaVersion: 1 as const, serverName: "files", toolName: "read", version: "1", sourceSchemaDigest: sha256({ required: ["path"] }), requiredArguments: ["path"], absolutePathArguments: [] };
    const contract = { ...contractBody, digest: sha256(contractBody) };
    const mcp = { serverName: "files", toolName: "read", contractDigest: contract.digest };
    const captured: ReturnType<typeof createCaptureEnvelope>[] = [];
    const add = (extra: Partial<CaptureEventInput>) => {
      const index = captured.length;
      const envelope = redactCaptureEnvelopeForPersistence(createCaptureEnvelope({
        adapter: "copilot-cli", adapterVersion: "1.0.84-1", sourceEventId: `late-${index}`, sessionId: "late-session",
        repoId: "repo", worktree: "C:\repo", repositoryState: "known_repo", eventType: "tool.started", trust: "tool",
        timestamp: new Date(base + index * 1000).toISOString(), toolName: "files-read", mcp,
        ...(captured.at(-1) ? { parentEventId: captured.at(-1)?.event.eventId } : {}), ...extra,
      })).envelope;
      captured.push(envelope);
      store.ingestQueueItem(captureQueueItemSchema.parse({ schemaVersion: 1, queueItemId: `late-queue-${index}`, state: "pending", attemptCount: 0, failureCount: 0, createdAt: envelope.event.timestamp, updatedAt: envelope.event.timestamp, envelope }));
      return envelope;
    };
    const failed = add({ operationId: "failed", content: { toolArguments: {} } });
    add({ eventType: "tool.failed", operationId: "failed", completionStatus: "failed", mcp: { ...mcp, isError: true, failureArgument: "path" } });
    const user = add({ eventType: "prompt.submitted", trust: "user", content: { message: "Always include the path argument." } });
    const retry = add({ operationId: "retry", content: { toolArguments: { path: "README.md" } } });
    const completed = add({ eventType: "tool.completed", operationId: "retry", completionStatus: "succeeded", mcp: { ...mcp, isError: false } });
    let calls = 0; let available = false;
    let time = now();
    const coordinator = new LearningCoordinator({ store, now: () => time, enabled: async () => true,
      contracts: () => available ? [contract] : [], lease: { tryAcquire: async () => ({ release: async () => undefined }) },
      provider: { identity: { provider: "fixture", model: "fixture", version: "1" }, infer: async () => { calls += 1; return { schemaVersion: 1, proposals: [{
        rule: "Supply path.", trigger: "Read files", exclusions: ["Other tools"], userSource: { eventId: user.event.eventId, quote: "Always include the path argument." },
        failedOperationEventId: failed.event.eventId, retryOperationEventId: retry.event.eventId, completionEventId: completed.event.eventId,
        predicate: { kind: "required_argument", serverName: "files", toolName: "read", argument: "path", contractDigest: contract.digest },
      }] }; } },
    });
    try {
      expect(await coordinator.run()).toMatchObject({ status: "evaluated", qualified: 0 });
      const candidate = store.knowledgeCandidates()[0];
      if (!candidate) throw new Error("Expected a waiting candidate.");
      const proposal = store.learningProposals()[0];
      const job = store.learningJobs()[0];
      if (scenario === "archived") store.upsertKnowledgeCandidates([{ ...candidate, state: "archived" }]);
      if (scenario === "revoked") store.recordKnowledgeFeedback({ event: { schemaVersion: 1, feedbackId: "revoked-late-contract", kind: "revoke", source: "user", targetType: "knowledge", targetId: candidate.knowledgeId, evidenceRef: "real-user-revocation", timestamp: new Date(base + 6000).toISOString() } });
      if (scenario === "expired") time = new Date(base + 31 * 86_400_000);
      if (scenario === "deleted") {
        const target = { targetType: "knowledge" as const, targetId: candidate.knowledgeId };
        const deletion = store.beginDeletion(target); store.deleteCanonicalTarget(deletion.deletionId, target);
      }
      available = true;
      const result = await coordinator.run();
      expect(calls).toBe(1);
      if (scenario === "late_contract") {
        expect(result).toMatchObject({ status: "evaluated", qualified: 1 });
        expect(store.knowledgeCandidates()[0]).toMatchObject({ state: "active", evidenceTier: "externally_verified", createdAt: candidate.createdAt, sourceEvidenceIds: candidate.sourceEvidenceIds });
        expect(store.learningProposals()).toEqual([proposal]);
        expect(store.learningJobs()[0]).toMatchObject({ attempts: job?.attempts, expiresAt: job?.expiresAt, state: "evaluated" });
        expect(store.learningReceipts()).toHaveLength(1);
        expect((await coordinator.run()).status).toBe("idle");
        expect(store.learningReceipts()).toHaveLength(1);
      } else {
        expect(store.knowledgeCandidates().some((entry) => entry.state === "active")).toBe(false);
        expect(store.learningReceipts()).toEqual([]);
      }
    } finally { store.close(); }
  });
  it("analyzes an ordinary source once, retains a candidate and preserves raw provenance", async () => {
    const f = fixture();
    try {
      const before = f.store.rawEvents();
      expect(await new LearningCoordinator(f.options).run()).toMatchObject({ status: "evaluated", proposals: 1, qualified: 0 });
      expect(f.store.learningJobs()[0]?.state).toBe("waiting_evidence");
      expect(f.store.knowledgeCandidates()[0]).toMatchObject({ state: "candidate", evidenceTier: "inferred" });
      expect(f.store.rawEvents()).toEqual(before);
      expect(await new LearningCoordinator(f.options).run()).toMatchObject({ status: "idle" });
      expect(f.calls()).toBe(1);
    } finally { f.store.close(); }
  });

  it("does not commit an in-flight response after source deletion", async () => {
    const f = fixture();
    try {
      const original = f.options.provider.infer;
      const result = await new LearningCoordinator({ ...f.options, provider: { ...f.options.provider, infer: async () => {
        const response = await original();
        const target = { targetType: "source" as const, targetId: f.captured[2]?.event.eventId ?? "missing" };
        const deletion = f.store.beginDeletion(target);
        f.store.deleteCanonicalTarget(deletion.deletionId, target);
        return response;
      } } }).run();
      expect(result.status).toBe("cancelled");
      expect(f.store.learningJobs()).toEqual([]);
      expect(f.store.learningProposals()).toEqual([]);
      expect(f.store.knowledgeCandidates()).toEqual([]);
    } finally { f.store.close(); }
  });

  it("charges malformed inference attempts and stops at three", async () => {
    const f = fixture();
    try {
      const coordinator = new LearningCoordinator({ ...f.options, provider: { ...f.options.provider, infer: async () => ({ schemaVersion: 1, proposals: [{ rule: "invented" }] }) } });
      for (let i = 0; i < 3; i += 1) expect((await coordinator.run()).status).toBe("failed");
      expect((await coordinator.run()).status).toBe("idle");
      expect(f.store.learningJobs()[0]?.attempts).toBe(3);
      expect(f.store.learningProposals()).toEqual([]);
    } finally { f.store.close(); }
  });

  it("retries extraction that points at a failure result rather than its operation start", async () => {
    const f = fixture();
    try {
      const infer = f.options.provider.infer;
      const coordinator = new LearningCoordinator({ ...f.options, provider: { ...f.options.provider, infer: async () => {
        const response = await infer();
        return { ...response, proposals: response.proposals.map((proposal) => ({ ...proposal, failedOperationEventId: f.captured[1]?.event.eventId })) };
      } } });
      expect((await coordinator.run()).status).toBe("failed");
      expect(f.store.learningProposals()).toEqual([]);
      expect(f.store.knowledgeCandidates()).toEqual([]);
      expect((await new LearningCoordinator(f.options).run()).status).toBe("evaluated");
      expect(f.calls()).toBe(2);
      expect(f.store.learningJobs()[0]?.attempts).toBe(2);
    } finally { f.store.close(); }
  });

  it("treats zero proposals as no-rule, honors disabled learning and bounds settings", async () => {
    const f = fixture();
    try {
      expect((await new LearningCoordinator({ ...f.options, enabled: async () => false }).run()).status).toBe("disabled");
      expect(f.calls()).toBe(0);
      expect(() => new LearningCoordinator({ ...f.options, dailyLimit: -1 })).toThrow();
      expect(await new LearningCoordinator({ ...f.options, provider: { ...f.options.provider, infer: async () => ({ schemaVersion: 1, proposals: [] }) } }).run()).toMatchObject({ status: "evaluated", proposals: 0 });
      expect(f.store.learningJobs()[0]?.result).toBe("no_rule");
    } finally { f.store.close(); }
  });
});
