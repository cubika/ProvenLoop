import { describe, expect, it } from "vitest";
import type { CaptureEnvelope, LearningToolContract, RuleProposal } from "@provenloop/contracts";
import { createCaptureEnvelope, learningSourceDigest, verifyMcpRecovery, sha256, type CaptureEventInput } from "@provenloop/domain";
import { buildLearningWindows, learningKnowledgeCandidate, containsPotentialSecret } from "@provenloop/domain";
import { CanonicalKnowledgeRetriever, knowledgeProjectionFromCandidate } from "@provenloop/retrieval";
import { KnowledgeControlService } from "@provenloop/host";

const fixture = () => {
  const contractBody = { schemaVersion: 1 as const, serverName: "files", toolName: "read", version: "1",
    sourceSchemaDigest: sha256({ type: "object", required: ["path"], properties: { path: { type: "string" } } }),
    requiredArguments: ["path"], absolutePathArguments: [] };
  const contract: LearningToolContract = { ...contractBody, digest: sha256(contractBody) };
  const event = (id: string, second: number, extra: Partial<CaptureEventInput>): CaptureEnvelope => createCaptureEnvelope({
    adapter: "copilot-cli", adapterVersion: "1.0.82-0", eventType: "tool.started", trust: "tool",
    sourceEventId: id, timestamp: new Date(Date.UTC(2026, 8, 1, 0, 0, second)).toISOString(),
    repoId: "repo-1", repositoryState: "known_repo", sessionId: "session-1", worktree: "C:/repo",
    toolName: "files-read", mcp: { serverName: "files", toolName: "read", contractDigest: contract.digest }, ...extra,
  });
  const failed = event("failed-start", 0, { operationId: "call-1", content: { toolArguments: {} } });
  const failure = event("failed-result", 1, { eventType: "tool.failed", operationId: "call-1",
    parentEventId: failed.event.eventId, completionStatus: "failed",
    mcp: { serverName: "files", toolName: "read", contractDigest: contract.digest, isError: true, failureArgument: "path" },
    content: { message: "Missing required argument path." } });
  const user = event("correction", 2, { eventType: "prompt.submitted", trust: "user",
    parentEventId: failure.event.eventId, content: { message: "Always supply the path argument for this tool." } });
  const retry = event("retry-start", 3, { operationId: "call-2", parentEventId: user.event.eventId,
    content: { toolArguments: { path: "readme.md" } } });
  const completion = event("retry-result", 4, { eventType: "tool.completed", operationId: "call-2",
    parentEventId: retry.event.eventId, completionStatus: "succeeded",
    mcp: { serverName: "files", toolName: "read", contractDigest: contract.digest, isError: false } });
  const events = [failed, failure, user, retry, completion];
  const proposal: RuleProposal = { schemaVersion: 1, proposalId: "proposal-1", jobId: "job-1", knowledgeId: "learning-knowledge-1",
    createdAt: user.event.timestamp, expiresAt: "2026-10-01T00:00:00Z", rule: "Always supply path.", trigger: "Reading a file",
    exclusions: ["Other tools"], userSource: { eventId: user.event.eventId, quote: "Always supply the path argument for this tool." },
    failedOperationEventId: failed.event.eventId, retryOperationEventId: retry.event.eventId, completionEventId: completion.event.eventId,
    predicate: { kind: "required_argument", serverName: "files", toolName: "read", argument: "path", contractDigest: contract.digest },
    sourceDigests: events.map((entry) => ({ eventId: entry.event.eventId, digest: learningSourceDigest(entry) })),
  };
  return { contract, proposal, events, failed, failure, user, retry, completion };
};
const verify = (input: ReturnType<typeof fixture>, events = input.events, refreshSources = true) =>
  verifyMcpRecovery({ ...input.proposal, ...(refreshSources ? { sourceDigests: events.map((entry) => ({ eventId: entry.event.eventId, digest: learningSourceDigest(entry) })) } : {}) },
    events, [input.contract], new Date("2026-09-01T00:00:05Z"));
const replace = (events: CaptureEnvelope[], selected: CaptureEnvelope, patch: Partial<CaptureEnvelope["event"]>): CaptureEnvelope[] =>
  events.map((entry) => entry === selected ? { ...entry, event: { ...entry.event, ...patch } } : entry);

describe("typed MCP correction proof", () => {
  it("renders admitted legacy digest applicability without treating the contract as a secret", async () => {
    const input = fixture();
    const receipt = verify(input);
    const window = buildLearningWindows(input.events, new Date("2026-09-01T00:00:10Z"))[0];
    if (!receipt || !window) throw new Error("Expected complete fixture proof.");
    const candidate = { ...learningKnowledgeCandidate(window, input.proposal, receipt),
      appliesWhen: [`files/read contract ${input.contract.digest}; argument path`] };
    expect(containsPotentialSecret(candidate.appliesWhen[0] ?? "")).toBe(true);
    const projection = { ...knowledgeProjectionFromCandidate(candidate), score: 1 };
    const retriever = new CanonicalKnowledgeRetriever({
      backend: { get: async () => projection, health: async () => ({ fts5Available: true, quickCheck: "ok", recordCount: 1, status: "healthy" }),
        index: async () => undefined, rebuild: async () => undefined, remove: async () => undefined, search: async () => [projection] },
      store: { knowledgeCandidates: () => [candidate], knowledgeCandidatesWithUnavailableSources: () => new Set(),
        knowledgeAdmissionEvidence: () => ({ learningProposals: [input.proposal], learningReceipts: [receipt],
          envelopes: input.events, correctionKeys: [], correctionSourceEventIds: new Set(), contextUseRecords: [], feedbackEvents: [], workEpisodes: [] }) },
    });
    const result = await retriever.search({ limit: 1, text: "files read", repositoryScopeId: "repo-1",
      toolInvocation: { serverName: "files", toolName: "read", contractDigest: input.contract.digest } });
    expect(result).toHaveLength(1);
    expect(result[0]?.candidate.appliesWhen).toEqual(["Calling files/read under its verified tool contract."]);
    expect(candidate.appliesWhen[0]).toContain(input.contract.digest);
    const controls = new KnowledgeControlService({
      projection: { acquireLease: async () => ({ release: async () => undefined }), rebuild: async () => undefined },
      store: { knowledgeCandidates: () => [candidate],
        knowledgeAdmissionEvidence: () => ({ envelopes: input.events, learningProposals: [input.proposal] }),
        recordKnowledgeFeedback: () => ({ candidate, recorded: false }), upsertKnowledgeCandidates: () => 0 },
    });
    const review = controls.review({ knowledgeId: candidate.knowledgeId, scope: "repository", scopeId: "repo-1" });
    expect(review.expectedDigest).toBe(sha256(candidate));
    expect(review.candidate).toEqual(candidate);
  });
  it("validates every native bookkeeping bridge and rejects adapter omissions", () => {
    const input = fixture();
    const bridge = { schemaVersion: 1 as const, sourceEventId: "hook-end", parentSourceEventId: input.retry.sourceEventId,
      eventType: "hook.end" as const, timestamp: "2026-09-01T00:00:03.500Z", sessionId: input.retry.event.sessionId ?? "",
      repoId: input.retry.event.repoId ?? "", worktree: input.retry.event.worktree ?? "", trust: "system" as const };
    expect(verify(input, replace(input.events, input.completion, { parentBridge: [bridge], originalParentSourceEventId: bridge.sourceEventId }))).toBeDefined();
    for (const bad of [{ ...bridge, parentSourceEventId: "not-the-retry" }, { ...bridge, repoId: "other-repo" },
      { ...bridge, timestamp: "2026-09-01T00:00:05Z" }]) {
      expect(verify(input, replace(input.events, input.completion, { parentBridge: [bad] }))).toBeUndefined();
    }
    expect(verify(input, replace(input.events, input.retry, { captureQuality: { schemaVersion: 1, omittedFields: ["toolArguments.format"], truncatedFields: [], originalLengths: {} } }))).toBeUndefined();
  });
  it("proves only the captured invocation contract for a complete missing-argument recovery", () => {
    expect(verify(fixture())).toMatchObject({ proves: "invocation_contract" });
  });
  it("rejects model-only contracts and arbitrary changed schemas", () => {
    const input = fixture();
    expect(verifyMcpRecovery(input.proposal, input.events, [], new Date())).toBeUndefined();
    input.contract.requiredArguments = ["other"];
    expect(verify(input)).toBeUndefined();
  });
  it("rejects generic transport errors without a trusted parameter-specific failure", () => {
    const input = fixture();
    expect(verify(input, replace(input.events, input.failure, {
      mcp: { serverName: "files", toolName: "read", contractDigest: input.contract.digest, isError: true },
    }))).toBeUndefined();
  });
  it("requires exact before/after argument correction and complete captured parameters", () => {
    const input = fixture();
    for (const argumentsValue of [{}, { path: null }, { path: "readme.md", format: "other" }]) {
      expect(verify(input, replace(input.events, input.retry, { redactedArguments: argumentsValue }))).toBeUndefined();
    }
    const redacted = input.events.map((entry) => entry === input.retry ? { ...entry,
      redaction: { ...entry.redaction, truncatedPaths: ["event.redactedArguments.path"] } } : entry);
    expect(verify(input, redacted)).toBeUndefined();
  });
  it("requires causal result binding and preserves workspace identity through intermediary parents", () => {
    const input = fixture();
    expect(verify(input, replace(input.events, input.failure, { parentEventId: "unrelated" }))).toBeUndefined();
    expect(verify(input, replace(input.events, input.completion, { parentEventId: "unrelated" }))).toBeUndefined();
    const bridge = { ...input.retry, event: { ...input.retry.event, eventId: "bridge", eventType: "agent.message" as const,
      trust: "model" as const, repoId: "other-repository", timestamp: "2026-09-01T00:00:02.500Z" } };
    expect(verify(input, [...replace(input.events, input.retry, { parentEventId: bridge.event.eventId }), bridge])).toBeUndefined();
  });
  it("rejects conflicting or ambiguous native completion evidence", () => {
    const input = fixture();
    const contradiction = { ...input.completion, event: { ...input.completion.event, eventId: "conflicting-result",
      eventType: "tool.failed" as const, completionStatus: "failed" as const,
      mcp: { ...input.contract, serverName: "files", toolName: "read", contractDigest: input.contract.digest, isError: true } } };
    expect(verify(input, [...input.events, contradiction])).toBeUndefined();
    expect(verify(input, replace(input.events, input.completion, { operationId: "unrelated-call" }))).toBeUndefined();
  });
  it("requires every critical source in the immutable proof and rejects stale source hashes", () => {
    const input = fixture();
    input.proposal.sourceDigests = input.proposal.sourceDigests.filter((source) => source.eventId !== input.user.event.eventId);
    expect(verify(input, input.events, false)).toBeUndefined();
    const changed = replace(input.events, input.retry, { redactedArguments: { path: "different.md" } });
    expect(verify(fixture(), changed, false)).toBeUndefined();
  });
});
