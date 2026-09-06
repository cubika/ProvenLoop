import { describe, expect, it } from "vitest";
import {
  BranchContextBuilder,
  createCaptureEnvelope,
  WorkEpisodeBuilder,
  type CaptureEventInput,
} from "@provenloop/domain";

const event = (
  sourceEventId: string,
  eventType: string,
  extra: Partial<CaptureEventInput> = {},
) => createCaptureEnvelope({
  adapter: "copilot-cli",
  adapterVersion: "1.0.82-0",
  branch: "main",
  commitSha: "a".repeat(40),
  eventType,
  repoId: "repo-1",
  sessionId: "session-1",
  sourceEventId,
  timestamp: "2026-09-01T00:00:00.000Z",
  trust: "tool",
  worktree: "C:\\repo",
  ...extra,
});

const project = (events: ReturnType<typeof event>[]) =>
  new BranchContextBuilder().build(
    events,
    new WorkEpisodeBuilder().build(events).episodes,
  );

describe("BranchContextBuilder material evidence", () => {
  it("does not turn HEAD observations or legacy workspace snapshots into work", () => {
    const observations = [
      event("head", "git.head_changed"),
      event("workspace-commit-legacy", "git.commit"),
    ];
    expect(project(observations)).toEqual([]);
    expect(new WorkEpisodeBuilder().build(observations).episodes[0]?.commitIds).toEqual([]);
  });

  it("ignores model-authored changes and verification claims", () => {
    expect(project([
      event("model-change", "file.changed", {
        content: { message: "src\\account.ts" },
        trust: "model",
      }),
      event("model-test", "verification.completed", {
        completionStatus: "succeeded",
        trust: "model",
      }),
    ])).toEqual([]);
  });

  it("shows actual changed files and failed verification without inventing success", () => {
    const prompt = event("prompt", "prompt.submitted", {
      content: { message: "修复账号日志\nNext: 检查回归结果" },
      trust: "user",
    });
    const changed = event("change", "file.changed", {
      content: { message: "src\\account.ts" },
      timestamp: "2026-09-01T00:01:00.000Z",
    });
    const verification = event("verification", "verification.completed", {
      completionStatus: "succeeded",
      exitCode: 1,
      timestamp: "2026-09-01T00:02:00.000Z",
    });
    const [context] = project([prompt, changed, verification]);
    expect(context).toMatchObject({
      goal: "修复账号日志",
      implementationState: [
        "Files changed: src\\account.ts",
        "verification.completed: failed",
      ],
      recentVerificationEvidenceIds: [verification.event.eventId],
      unfinishedItems: ["检查回归结果"],
    });
    expect(new WorkEpisodeBuilder().build([prompt, changed, verification]).episodes[0])
      .toMatchObject({ outcome: "failure", outcomeQualification: "qualified" });
  });

  it("does not call ordinary tool completion a successful outcome", () => {
    const input = [event("tool", "tool.completed", { completionStatus: "succeeded" })];
    expect(project(input)).toEqual([]);
    expect(new WorkEpisodeBuilder().build(input).episodes[0])
      .toMatchObject({ outcome: "unknown", outcomeQualification: "open" });
  });

  it("keeps a cancelled latest verification unknown rather than reusing an older success", () => {
    const input = [
      event("success", "test.completed", { completionStatus: "succeeded" }),
      event("cancelled", "test.completed", {
        completionStatus: "cancelled",
        exitCode: 1,
        timestamp: "2026-09-01T00:01:00.000Z",
      }),
    ];
    expect(new WorkEpisodeBuilder().build(input).episodes[0])
      .toMatchObject({ outcome: "unknown", outcomeQualification: "open" });
    expect(project(input)[0]?.implementationState).toContain("test.completed: unknown");
  });
});
