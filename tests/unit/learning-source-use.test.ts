import { afterEach, describe, expect, it } from "vitest";
import assert from "node:assert/strict";
import { captureQueueItemSchema, type RuleProposalInput } from "@provenloop/contracts";
import { createCaptureEnvelope, redactCaptureEnvelopeForPersistence, learningSourceUse } from "@provenloop/domain";
import { LearningCoordinator } from "@provenloop/host";
import { CanonicalSqliteStore } from "@provenloop/storage-sqlite";
import { CanonicalKnowledgeRetriever, ContextRetrievalService, KnowledgeProjectionManager, SqliteFtsKnowledgeBackend } from "@provenloop/retrieval";

const disposables: { close(): void }[] = [];
afterEach(() => { for (const item of disposables.splice(0).reverse()) item.close(); });
const date = new Date("2026-09-10T08:00:10.000Z");
const revision = "a".repeat(40);

const fixture = async (kind: "convention" | "reference") => {
  const store = new CanonicalSqliteStore(":memory:");
  const backend = new SqliteFtsKnowledgeBackend(":memory:");
  disposables.push(store, backend);
  const userText = kind === "convention" ? "Always document repository API examples in English." : "Investigate how the widget cache avoids stale entries.";
  const quote = "Widget cache entries require a revision key because revisions isolate stale data.";
  const inputs = [{ type: "prompt.submitted", trust: "user" as const, content: { message: userText } },
    { type: "tool.completed", trust: "tool" as const, content: { toolResult: quote } }];
  for (const [index, item] of inputs.entries()) {
    const timestamp = new Date(date.getTime() - 10_000 + index * 1000).toISOString();
    const envelope = redactCaptureEnvelopeForPersistence(createCaptureEnvelope({ adapter: "copilot-cli", adapterVersion: "1.0.84-1",
      sessionId: "source-session", sourceEventId: `source-${index}`, repoId: "repo", worktree: "C:\\repo",
      repositoryState: "known_repo", branch: "main", commitSha: revision, timestamp, eventType: item.type, trust: item.trust, content: item.content })).envelope;
    store.ingestQueueItem(captureQueueItemSchema.parse({ schemaVersion: 1, queueItemId: `q-${index}`, state: "pending",
      attemptCount: 0, failureCount: 0, createdAt: timestamp, updatedAt: timestamp, envelope }));
  }
  const events = store.episodeSourceEnvelopes();
  const source = events[0];
  const tool = events[1];
  assert(source && tool);
  const proposal: RuleProposalInput = { rule: kind === "convention" ? "Document API examples in English." : "Widget cache requires revision isolation.",
    trigger: kind === "convention" ? "Writing repository API examples" : "Inspecting widget cache revision keys", exclusions: ["Unrelated projects"],
    userSource: { eventId: source.event.eventId, quote: userText },
    supportingSources: kind === "convention" ? [{ eventId: source.event.eventId, quote: userText }] : [{ eventId: tool.event.eventId, quote }],
    retention: { kind, lifetime: "durable", rationale: "This constraint changes future implementation and review choices.",
      futureUse: kind === "convention" ? "When writing additional repository API examples." : "When investigating widget cache revision invalidation.",
      targetRepository: { status: "captured", repoId: "repo" } } };
  const coordinator = new LearningCoordinator({ store, now: () => date, enabled: async () => true,
    lease: { tryAcquire: async () => ({ release: async () => undefined }) },
    provider: { identity: { provider: "fixture", model: "fixture", version: "1" }, infer: async () => ({ schemaVersion: 1, proposals: [proposal] }) } });
  expect(await coordinator.run()).toMatchObject({ status: "evaluated", proposals: 1 });
  expect(store.learningJobs()[0]?.state).toBe("evaluated");
  await new KnowledgeProjectionManager({ store, backend }).rebuild();
  const candidate = store.knowledgeCandidates()[0];
  assert(candidate);
  return { store, backend, events, candidate, retriever: new CanonicalKnowledgeRetriever({ store, backend }) };
};

describe("source-supported learning delivery", () => {
  it("returns a lasting convention as exact user wording without marking it verified", async () => {
    const f = await fixture("convention");
    const service = new ContextRetrievalService({ store: f.store, backend: f.backend, now: () => date, timeoutMs: 5000 });
    const result = await service.context({ cwd: "C:\\repo", repoId: "repo", sessionId: "later-session",
      prompt: "Write repository API examples in English", tokenBudget: 1200, headSha: revision });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ deliveryMode: "convention", evidenceTier: "inferred" });
    expect(result.items[0]?.guidance).toContain("Always document repository API examples in English.");
    expect(f.store.knowledgeCandidates()[0]).toMatchObject({ state: "candidate", evidenceTier: "inferred", evidenceMarks: [] });
    const proposals = f.store.learningProposals();
    const original = proposals[0]; assert(original?.userSource);
    const cropped = { ...original, userSource: { ...original.userSource, quote: "API examples in English" } };
    expect(learningSourceUse(f.candidate, [cropped], f.events)?.sources[0]?.quote).toBe("Always document repository API examples in English.");
  });

  it("returns a cited reference only in the matching repository, worktree and revision", async () => {
    const f = await fixture("reference");
    const query = { text: "widget cache", limit: 3, now: date, repositoryScopeId: "repo", worktree: "C:\\repo", headSha: revision };
    expect(await f.retriever.search(query)).toMatchObject([{ deliveryMode: "reference", sources: [{ role: "tool" }] }]);
    expect(await f.retriever.search({ ...query, worktree: "C:/repo/src" })).toHaveLength(1);
    expect(await f.retriever.search({ ...query, repositoryScopeId: "elsewhere" })).toEqual([]);
    expect(await f.retriever.search({ ...query, worktree: "C:\\other" })).toEqual([]);
    expect(await f.retriever.search({ ...query, headSha: "b".repeat(40) })).toEqual([]);
    const service = new ContextRetrievalService({ store: f.store, backend: f.backend, now: () => date, timeoutMs: 5000 });
    const result = await service.context({ cwd: query.worktree, repoId: "repo", sessionId: "later-reference",
      prompt: "Inspect widget cache revision keys", tokenBudget: 1200, headSha: revision });
    expect(result.items[0]?.guidance).toContain("Check the cited source");
    expect(result.items[0]?.sources?.[0]?.quote).toContain("revision key");
    expect(result.items[0]?.guidance).not.toContain(f.candidate.content);
  });

  it("rejects edited text, invalid source digests, legacy proposals, and recalled evidence", async () => {
    const f = await fixture("reference");
    const proposals = f.store.learningProposals();
    expect(learningSourceUse(f.candidate, proposals, f.events)).toBeDefined();
    expect(learningSourceUse({ ...f.candidate, conflictsWith: ["other-knowledge"] }, proposals, f.events)).toBeUndefined();
    expect(learningSourceUse({ ...f.candidate, content: "Invented claim" }, proposals, f.events)).toBeUndefined();
    expect(learningSourceUse(f.candidate, proposals, f.events.slice(0, 1))).toBeUndefined();
    const original = proposals[0];
    const firstEvent = f.events[0];
    assert(original && firstEvent);
    const legacy = { ...original };
    delete legacy.retention;
    expect(learningSourceUse(f.candidate, [legacy], f.events)).toBeUndefined();
    expect(learningSourceUse(f.candidate, proposals, f.events, [{ schemaVersion: 1, requestId: "recall", sessionId: "source-session",
      candidateKnowledgeIds: [], returnedKnowledgeIds: [`knowledge:${f.candidate.knowledgeId}`], appliedKnowledgeIds: [],
      createdAt: firstEvent.event.timestamp, latencyMs: 0, renderedTokens: 10, retrievalStatus: "provided" }])).toBeUndefined();
  });

  it("honors revocation and expires references without promoting them", async () => {
    const f = await fixture("reference");
    const query = { text: "widget cache", limit: 3, now: date, repositoryScopeId: "repo", worktree: "C:\\repo", headSha: revision };
    expect(await f.retriever.search({ ...query, now: new Date("2027-01-01") })).toEqual([]);
    f.store.recordKnowledgeFeedback({ event: { schemaVersion: 1, feedbackId: "revoke", evidenceRef: "user-review",
      kind: "revoke", source: "user", targetType: "knowledge", targetId: f.candidate.knowledgeId, timestamp: date.toISOString() } });
    expect(await f.retriever.search(query)).toEqual([]);
  });
});

describe("task-scoped continuation delivery", () => {
  it("keeps temporary branch context in its session unless the prior episode is explicitly selected", async () => {
    const store = new CanonicalSqliteStore(":memory:");
    const backend = new SqliteFtsKnowledgeBackend(":memory:");
    disposables.push(store, backend);
    const context = { schemaVersion: 1 as const, branchContextId: "task-context", branch: "main", headSha: revision, repoId: "repo",
      goal: "Inspect the deployment identity", explicitConstraints: ["Inspect resource deployment, not the MSI."], acceptedDecisions: [],
      implementationState: [], unfinishedItems: ["Check tenant access"], recentVerificationEvidenceIds: [], sourceEventIds: [],
      sourceEpisodeIds: ["episode-source"], sourceSessionIds: ["source-task"], updatedAt: date.toISOString() };
    store.replaceBranchContextProjection({ contexts: [context] });
    const service = new ContextRetrievalService({ store, backend, now: () => date, timeoutMs: 5000 });
    const request = { cwd: "C:/repo", repoId: "repo", branch: "main", headSha: revision, prompt: "Inspect deployment identity", tokenBudget: 1200 };
    expect((await service.context({ ...request, sessionId: "unrelated" })).items).toEqual([]);
    expect((await service.context({ ...request, sessionId: "source-task" })).items).toHaveLength(1);
    expect((await service.context({ ...request, sessionId: "continued", continuationEpisodeId: "episode-source" })).items).toHaveLength(1);
    store.replaceBranchContextProjection({ contexts: [{ ...context, closedAt: date.toISOString() }] });
    expect((await service.context({ ...request, sessionId: "after-close", continuationEpisodeId: "episode-source" })).items).toEqual([]);
    const legacy = { ...context };
    Reflect.deleteProperty(legacy, "sourceSessionIds");
    store.replaceBranchContextProjection({ contexts: [legacy] });
    expect((await service.context({ ...request, sessionId: "unrelated-legacy" })).items).toEqual([]);
  });
});
