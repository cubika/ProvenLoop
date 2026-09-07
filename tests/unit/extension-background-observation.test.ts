import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const work = vi.hoisted(() => ({
  installed: vi.fn(),
  worker: vi.fn(),
  collect: vi.fn(),
  reconcile: vi.fn(),
}));

vi.mock("@provenloop/copilot-adapter", async (original) => ({
  ...await original<typeof import("@provenloop/copilot-adapter")>(),
  runInstalledCopilotExtension: work.installed,
}));
vi.mock("../../packages/cli/src/run-worker.js", () => ({
  runCaptureWorkerOnce: work.worker,
}));
vi.mock("../../packages/cli/src/collect-observations.js", () => ({
  collectLocalObservations: work.collect,
  invalidateLocalObservationProjection: vi.fn(),
}));
vi.mock("../../packages/cli/src/reconcile-capture.js", () => ({
  reconcileCurrentSessionCapture: work.reconcile,
}));

import { runProvenLoopCopilotExtension } from "@provenloop/cli";
import { runInstalledCopilotExtension } from "../../packages/cli/src/extension-entry.js";

let stop: (() => void) | undefined;
const options = {
  dataRoot: "C:\\provenloop-background-test",
  joinSession: async () => ({ on: () => undefined }),
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  stop = undefined;
  const once = process.once.bind(process);
  vi.spyOn(process, "once").mockImplementation((event, listener) => {
    if (event === "SIGTERM") {
      stop = () => { listener(); };
      return process;
    }
    return once(event, listener);
  });
  work.installed.mockResolvedValue({ status: "started" });
  work.worker.mockResolvedValue({
    status: "completed",
    acknowledged: 0,
    deadLettered: 0,
    retried: 0,
  });
  work.collect.mockResolvedValue({
    status: "recorded",
    events: 0,
    contextUses: 0,
    pending: false,
  });
  work.reconcile.mockResolvedValue({ status: "skipped", reason: "capture_or_worker_disabled" });
});

afterEach(() => {
  stop?.();
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("automatic Extension observation scheduling", () => {
  it("exports the complete scheduler under the entry name used by installed plugins", () => {
    expect(runInstalledCopilotExtension).toBe(runProvenLoopCopilotExtension);
  });
  it("continues capture and observation while background inference is unresolved", async () => {
    let finish: ((result: { status: "disabled" }) => void) | undefined;
    const runLearning = vi.fn(() => new Promise<{ status: "disabled" }>((resolve) => { finish = resolve; }));
    await runProvenLoopCopilotExtension(options, { runLearning });
    await vi.advanceTimersByTimeAsync(0);
    expect(runLearning).toHaveBeenCalledTimes(1);
    expect(work.collect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(work.worker).toHaveBeenCalledTimes(2);
    expect(work.collect).toHaveBeenCalledTimes(2);
    expect(runLearning).toHaveBeenCalledTimes(1);
    stop?.();
    finish?.({ status: "disabled" });
    await vi.advanceTimersByTimeAsync(0);
    expect(work.worker).toHaveBeenCalledTimes(2);
  });

  it("collects without an acceptance command and throttles idle work", async () => {
    await runProvenLoopCopilotExtension(options);
    await vi.advanceTimersByTimeAsync(0);
    expect(work.worker).toHaveBeenCalledTimes(1);
    expect(work.collect).toHaveBeenCalledWith({ dataRoot: options.dataRoot });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(work.collect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(work.collect).toHaveBeenCalledTimes(2);
    stop?.();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(work.collect).toHaveBeenCalledTimes(2);
  });

  it("catches up bounded observation pages without starting another service", async () => {
    work.collect.mockResolvedValueOnce({
      status: "recorded",
      events: 500,
      contextUses: 500,
      pending: true,
    });
    await runProvenLoopCopilotExtension(options);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(work.worker).toHaveBeenCalledTimes(2);
    expect(work.collect).toHaveBeenCalledTimes(2);
  });

  it("does not schedule side effects for a disabled integration", async () => {
    work.installed.mockResolvedValue({ status: "disabled" });
    await runProvenLoopCopilotExtension(options);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(work.worker).not.toHaveBeenCalled();
    expect(work.collect).not.toHaveBeenCalled();
    expect(work.reconcile).not.toHaveBeenCalled();
  });

  it("leaves observations pending when resource admission blocks the worker", async () => {
    work.worker.mockResolvedValue({ status: "circuit_open", reasons: ["memory"] });
    await runProvenLoopCopilotExtension(options);
    await vi.advanceTimersByTimeAsync(0);
    expect(work.collect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(work.worker).toHaveBeenCalledTimes(2);
  });

  it("surfaces observation failure and retries without breaking the worker", async () => {
    work.collect.mockRejectedValueOnce(new Error("Observation storage is busy."));
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await runProvenLoopCopilotExtension(options);
    await vi.advanceTimersByTimeAsync(0);
    expect(diagnostic).toHaveBeenCalledWith(
      expect.stringContaining("ProvenLoop local observation failed"),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(work.worker).toHaveBeenCalledTimes(2);
    expect(work.collect).toHaveBeenCalledTimes(2);
  });

  it("reconciles only the SDK-bound Session after worker admission and drains new events promptly", async () => {
    const captureSession = {
      sessionId: "sdk-session",
      sessionStateRoot: "C:\\sdk-state",
      minimumTimestamp: "2026-09-01T00:00:00.000Z",
    };
    work.installed.mockResolvedValue({ status: "started", captureSession });
    work.reconcile.mockResolvedValueOnce({
      status: "reconciled",
      enrichedEvents: 1,
      diagnostics: [],
      reconciliation: { status: "reconciled", queuedEvents: 2 },
    });
    await runProvenLoopCopilotExtension(options);
    await vi.advanceTimersByTimeAsync(0);
    expect(work.reconcile).toHaveBeenCalledWith({ dataRoot: options.dataRoot, ...captureSession });
    expect(work.worker.mock.invocationCallOrder[0]).toBeLessThan(work.reconcile.mock.invocationCallOrder[0] ?? 0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(work.worker).toHaveBeenCalledTimes(2);
    expect(work.reconcile).toHaveBeenCalledTimes(2);
  });

  it("does not reconcile without SDK workspace metadata or while the worker is blocked", async () => {
    await runProvenLoopCopilotExtension(options);
    await vi.advanceTimersByTimeAsync(0);
    expect(work.reconcile).not.toHaveBeenCalled();
    stop?.();
    work.installed.mockResolvedValue({
      status: "started",
      captureSession: { sessionId: "sdk-session", sessionStateRoot: "C:\\sdk-state", minimumTimestamp: new Date().toISOString() },
    });
    work.worker.mockResolvedValue({ status: "circuit_open", reasons: ["memory"] });
    await runProvenLoopCopilotExtension(options);
    await vi.advanceTimersByTimeAsync(0);
    expect(work.reconcile).not.toHaveBeenCalled();
  });

  it("stops background reconciliation when the installed SDK runtime stops", async () => {
    await runProvenLoopCopilotExtension(options);
    await vi.advanceTimersByTimeAsync(0);
    const installedOptions = work.installed.mock.calls[0]?.[0] as { onStopped: () => void };
    installedOptions.onStopped();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(work.worker).toHaveBeenCalledTimes(1);
  });

  it("reports rejected reconciliation without failing normal background observations", async () => {
    work.installed.mockResolvedValue({
      status: "started",
      captureSession: { sessionId: "sdk-session", sessionStateRoot: "C:\\sdk-state", minimumTimestamp: new Date().toISOString() },
    });
    work.reconcile.mockResolvedValue({ status: "rejected", reason: "session_source_escape" });
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await runProvenLoopCopilotExtension(options);
    await vi.advanceTimersByTimeAsync(0);
    expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining("session_source_escape"));
    expect(work.collect).toHaveBeenCalledTimes(1);
  });
});
