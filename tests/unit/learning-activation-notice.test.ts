import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CanonicalSqliteStore } from "@provenloop/storage-sqlite";
import { resolveWindowsProvenLoopPaths } from "@provenloop/platform-windows";
import { createDefaultCopilotAdapterState, setPersistedCapability, writeCopilotAdapterState } from "../../packages/copilot-adapter/src/operational-state.js";
import { notifyLearningActivation } from "../../packages/cli/src/run-learning.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const fixture = async (enabled = true, notificationsEnabled = true) => {
  const root = await mkdtemp(join(tmpdir(), "provenloop-activation-notice-"));
  roots.push(root);
  const paths = resolveWindowsProvenLoopPaths(root);
  const now = new Date();
  const state = setPersistedCapability(createDefaultCopilotAdapterState(now), "correction_learning", { enabled: true }, now);
  await writeCopilotAdapterState(paths.adapterState, { ...state, automaticLearning: {
    consentedAt: now.toISOString(), disclosureVersion: 1, enabled, notificationsEnabled,
  } });
  return { root, paths };
};

describe("activation notice delivery boundary", () => {
  it("releases a durable claim when logging fails, then delivers it once on retry", async () => {
    const { root } = await fixture();
    // Model the canonical claim boundary; domain proof admission is tested separately.
    const claims = new Set<string>();
    const claim = vi.spyOn(CanonicalSqliteStore.prototype, "claimLearningActivationNotice").mockImplementation((id) => {
      if (claims.has(id)) return false;
      claims.add(id); return true;
    });
    const release = vi.spyOn(CanonicalSqliteStore.prototype, "releaseLearningActivationNotice").mockImplementation((id) => { claims.delete(id); });
    const id = "learning-knowledge-notice-fixture";
    await expect(notifyLearningActivation(root, [id], async () => { throw new Error("Host log unavailable."); })).rejects.toThrow("Host log unavailable");
    expect(release).toHaveBeenCalledWith(id);
    expect(claims.size).toBe(0);
    const log = vi.fn<(message: string) => Promise<void>>(async () => undefined);
    expect(await notifyLearningActivation(root, [id], log)).toBe(true);
    expect(await notifyLearningActivation(root, [id], log)).toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledTimes(3);
    const message = log.mock.calls[0]?.[0] ?? "";
    expect(message).toContain("knowledge show " + id);
    expect(message).toContain('--data-root "' + root + '"');
    expect(message).toContain("knowledge revoke");
    expect(message).toContain("provenloop forget");
    expect(message).not.toContain("SOURCE_SNIPPET");
  });
  it.each([[false, true], [true, false]])("suppresses disabled learning or muted notifications before claiming (%s, %s)", async (enabled, notificationsEnabled) => {
    const { root } = await fixture(enabled, notificationsEnabled);
    const claim = vi.spyOn(CanonicalSqliteStore.prototype, "claimLearningActivationNotice");
    const log = vi.fn(async () => undefined);
    expect(await notifyLearningActivation(root, ["learning-knowledge-fixture"], log)).toBe(false);
    expect(claim).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
  it("does not log deleted or unknown canonical rules and blocks active deletion", async () => {
    const { root, paths } = await fixture();
    const log = vi.fn(async () => undefined);
    expect(await notifyLearningActivation(root, ["learning-knowledge-deleted"], log)).toBe(false);
    const store = new CanonicalSqliteStore(paths.database);
    try { store.beginDeletion({ targetType: "source", targetId: "event-" + "a".repeat(64) }); }
    finally { store.close(); }
    const claim = vi.spyOn(CanonicalSqliteStore.prototype, "claimLearningActivationNotice");
    expect(await notifyLearningActivation(root, ["learning-knowledge-fixture"], log)).toBe(false);
    expect(claim).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
  it("never looks up raw source bodies and bounds the summary to three admitted claims", async () => {
    const { root } = await fixture();
    vi.spyOn(CanonicalSqliteStore.prototype, "claimLearningActivationNotice").mockReturnValue(true);
    const raw = vi.spyOn(CanonicalSqliteStore.prototype, "rawEvents").mockImplementation(() => { throw new Error("SOURCE_SNIPPET"); });
    const log = vi.fn<(message: string) => Promise<void>>(async () => undefined);
    const ids = Array.from({ length: 5 }, (_, index) => "learning-knowledge-" + index);
    expect(await notifyLearningActivation(root, ids, log)).toBe(true);
    const message = log.mock.calls[0]?.[0] ?? "";
    expect(message).toContain("learned 3");
    expect(message).not.toContain("learning-knowledge-3");
    expect(message).not.toContain("SOURCE_SNIPPET");
    expect(raw).not.toHaveBeenCalled();
  });
});
