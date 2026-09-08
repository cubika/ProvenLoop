import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createFrozenLearningCorpus, prepareFrozenLearningEvaluation, runFrozenLearningEvaluation,
  reviewFrozenLearningEvaluation } from "@provenloop/evaluation";
import { learningSourceDigest, verifyLearningRecovery } from "@provenloop/domain";
import type { RuleProposal } from "@provenloop/contracts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const fixture = async () => { const root = await mkdtemp(join(tmpdir(), "pl-frozen-eval-")); roots.push(root);
  const preparedDirectory = join(root, "prepared"); await prepareFrozenLearningEvaluation({ outputDirectory: preparedDirectory });
  return { root, preparedDirectory, outputDirectory: join(root, "run") }; };
const provider = { identity: { provider: "test-provider", model: "test-model", version: "1" }, infer: async () => ({ schemaVersion: 1, proposals: [] }) };
const defaults = { provider, providerMode: "test_substitute" as const, codeVersion: "fixture-code", executableDigest: "a".repeat(64) };

describe("frozen automatic-learning evaluation workflow", () => {
  it("keeps source hashes and typed positive proof valid after corpus JSON persistence", () => {
    const corpus = createFrozenLearningCorpus();
    const persisted: ReturnType<typeof createFrozenLearningCorpus> = JSON.parse(JSON.stringify(corpus));
    for (const item of persisted.cases.filter((entry) => entry.designStratum === "correction")) {
      const [failed, , user, retry, completion] = item.window.events;
      const contract = item.contracts[0];
      if (!failed || !user || !retry || !completion || !contract || !user.content?.message) throw new Error("Missing fixture proof.");
      expect(item.window.sources.every((source, index) => {
        const event = item.window.events[index]; return event !== undefined && learningSourceDigest(event) === source.digest;
      })).toBe(true);
      const proposal: RuleProposal = { schemaVersion: 1, proposalId: "fixture-proposal", jobId: "fixture-job", knowledgeId: "learning-knowledge-fixture",
        createdAt: user.event.timestamp, expiresAt: "2026-10-01T00:00:00Z", rule: "Supply the required argument.", trigger: "This tool",
        exclusions: ["Other tools"], userSource: { eventId: user.event.eventId, quote: user.content.message },
        failedOperationEventId: failed.event.eventId, retryOperationEventId: retry.event.eventId, completionEventId: completion.event.eventId,
        predicate: { kind: "required_argument", serverName: contract.serverName, toolName: contract.toolName,
          argument: contract.requiredArguments[0] ?? "missing", contractDigest: contract.digest }, sourceDigests: item.window.sources };
      expect(verifyLearningRecovery(proposal, item.window.events, item.contracts, new Date("2026-09-01T00:00:10Z"))?.proves).toBe("invocation_contract");
    }
  });
  it("freezes 40 bilingual windows and 40 later tasks without assigning human labels", async () => {
    const first = createFrozenLearningCorpus(); expect(JSON.stringify(createFrozenLearningCorpus()) === JSON.stringify(first)).toBe(true);
    expect(first.cases).toHaveLength(40); expect(first.tasks).toHaveLength(40);
    expect(first.cases.filter((item) => item.designStratum === "correction")).toHaveLength(20);
    expect(first.cases.filter((item) => item.language === "zh")).toHaveLength(20);
    expect(first.tasks.filter((item) => item.designStratum === "related")).toHaveLength(20);
    const f = await fixture(); const review = JSON.parse(await readFile(join(f.preparedDirectory, "input-review-a.json"), "utf8"));
    expect(review.reviewerId).toBeNull(); expect(review.windows.every((item: { reusable: unknown }) => item.reusable === null)).toBe(true);
    await expect(prepareFrozenLearningEvaluation({ outputDirectory: f.preparedDirectory })).rejects.toThrow();
  });
  it("retains every retry and visible pending windows without treating model calls as acceptance", async () => {
    const f = await fixture(); let calls = 0;
    const run = await runFrozenLearningEvaluation({ ...defaults, ...f, maxRequests: 3, maxAttempts: 2,
      provider: { ...provider, infer: async () => { calls += 1; if (calls === 1) throw new Error("PRIVATE_SNIPPET"); return { schemaVersion: 1, proposals: [] }; } } });
    expect(run.attempts.map((item) => item.status)).toEqual(["provider_failed", "no_rule", "no_rule"]);
    expect(run.pendingCaseIds).toHaveLength(38); expect(run.complete).toBe(false); expect(run.inputLabelsFrozen).toBe(false);
    const ledger = await readFile(join(f.outputDirectory, "attempts.jsonl"), "utf8");
    expect(ledger).not.toContain("PRIVATE_SNIPPET"); expect(ledger.split("\n").filter(Boolean)).toHaveLength(7);
    expect(JSON.parse(await readFile(join(f.outputDirectory, "acceptance-summary.json"), "utf8")).status).toBe("insufficient_evidence");
  });
  it("rejects changed corpora and refuses retroactive input labels", async () => {
    const f = await fixture(); await runFrozenLearningEvaluation({ ...defaults, ...f, maxRequests: 1 });
    await expect(reviewFrozenLearningEvaluation({ runDirectory: f.outputDirectory, outputReviewPaths: [], outputPath: join(f.root, "review.json") })).rejects.toThrow("not frozen");
    await writeFile(join(f.preparedDirectory, "corpus.json"), JSON.stringify(createFrozenLearningCorpus()) + " ");
    await expect(runFrozenLearningEvaluation({ ...defaults, ...f, outputDirectory: join(f.root, "changed"), maxRequests: 1 })).rejects.toThrow("digest changed");
  });
  it("preserves quota-blocked windows as pending without dispatch", async () => {
    const f = await fixture(); let calls = 0;
    const run = await runFrozenLearningEvaluation({ ...defaults, ...f, reserveAttempt: () => false,
      provider: { ...provider, infer: async () => { calls += 1; return { schemaVersion: 1, proposals: [] }; } } });
    expect(calls).toBe(0); expect(run.attempts).toEqual([]); expect(run.pendingCaseIds).toHaveLength(40);
  });
  it("retains timeout and schema-validation failures as failures, never no-rule", async () => {
    const f = await fixture();
    const run = await runFrozenLearningEvaluation({ ...defaults, ...f, maxRequests: 1, deadlineMs: 5,
      provider: { ...provider, infer: () => new Promise(() => undefined) } });
    expect(run.attempts[0]?.status).toBe("timeout");
    const invalid = await runFrozenLearningEvaluation({ ...defaults, ...f, outputDirectory: join(f.root, "invalid"), maxRequests: 1,
      provider: { ...provider, infer: async () => ({ schemaVersion: 1, proposals: [{ rule: "unsupported" }] }) } });
    expect(invalid.attempts[0]?.status).toBe("validation_failed");
  });
});
