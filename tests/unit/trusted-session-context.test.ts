import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import * as atomicRename from "../../packages/copilot-adapter/src/atomic-rename.js";

import {
  readTrustedSessionContext,
  TrustedSessionContextPublisher,
} from "@provenloop/copilot-adapter";
import {
  resolveWindowsProvenLoopLeaseName,
  windowsNamedPipePath,
} from "@provenloop/platform-windows";

describe("trusted Session context", () => {
  it("SYS-04 retains dirty context after a failed atomic replacement and reports background errors safely", async () => {
    const root = await mkdtemp(join(process.cwd(), ".provenloop-context-"));
    const errors: unknown[] = [];
    const publisher = new TrustedSessionContextPublisher({ cwd: root, dataRoot: root, sessionId: "write-failure", repositoryId: "repo", branch: "main",
      onError: (error) => { errors.push(error); throw new Error("Diagnostic callback failed."); } });
    let replacement: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await publisher.start();
      const failure = Object.assign(new Error("write refused"), { code: "ENOSPC" });
      replacement = vi.spyOn(atomicRename, "replaceFileAtomically").mockRejectedValueOnce(failure);
      publisher.updateWorkspace({ cwd: root, repositoryId: "repo", branch: "next" });
      await vi.waitFor(() => expect(errors).toEqual([failure]));
      expect((await readTrustedSessionContext(root, "write-failure"))?.branch).toBe("main");
      await publisher.flush();
      expect((await readTrustedSessionContext(root, "write-failure"))?.branch).toBe("next");
    } finally {
      replacement?.mockRestore();
      await publisher.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("binds an active producer and invalidates approval when the workspace changes", async () => {
    const root = await mkdtemp(join(process.cwd(), ".provenloop-context-"));
    const now = new Date("2026-09-05T05:00:00.000Z");
    const errors: unknown[] = [];
    const publisher = new TrustedSessionContextPublisher({
      cwd: root,
      dataRoot: root,
      now: () => now,
      onError: (error) => errors.push(error),
      sessionId: "session-1",
      repositoryId: "repo-1",
      branch: "main",
    });
    try {
      expect(await readTrustedSessionContext(root, "session-1", now))
        .toBeUndefined();
      await publisher.start();
      const initial = await readTrustedSessionContext(root, "session-1", now);
      expect(initial?.cwd).toBe(root);
      publisher.observeUserMessage({
        eventId: "approval-1",
        text: "confirm PL-abcdef012345",
        timestamp: now.toISOString(),
      });
      await publisher.flush();
      const approved = await readTrustedSessionContext(root, "session-1", now);
      expect(approved?.workspaceVersion).toBe(initial?.workspaceVersion);
      expect(approved?.latestUserMessage?.eventId).toBe("approval-1");
      publisher.beginWorkspaceRefresh();
      await publisher.flush();
      const refreshing = await readTrustedSessionContext(root, "session-1", now);
      expect(refreshing?.repositoryState).toBe("unknown");
      expect(refreshing?.repositoryId).toBeUndefined();
      expect(refreshing?.workspaceVersion).toBe(initial?.workspaceVersion);
      publisher.updateWorkspace({ cwd: root, repositoryId: "repo-1", branch: "main" });
      await publisher.flush();
      const refreshed = await readTrustedSessionContext(root, "session-1", now);
      expect(refreshed?.repositoryState).toBe("known_repo");
      expect(refreshed?.workspaceVersion).toBe(initial?.workspaceVersion);
      expect(refreshed?.latestUserMessage?.eventId).toBe("approval-1");
      publisher.updateWorkspace({
        cwd: root,
        repositoryId: "repo-1",
        branch: "another-branch",
      });
      await publisher.flush();
      const changed = await readTrustedSessionContext(root, "session-1", now);
      expect(changed?.workspaceVersion).not.toBe(initial?.workspaceVersion);
      expect(changed?.latestUserMessage).toBeUndefined();
      expect(await readTrustedSessionContext(root, "session-2", now))
        .toBeUndefined();
      expect(await readTrustedSessionContext(
        root,
        "session-1",
        new Date(now.getTime() + 61_000),
      )).toBeUndefined();
      expect(errors).toEqual([]);
      await publisher.stop();
      expect(await readTrustedSessionContext(root, "session-1", now))
        .toBeUndefined();
    } finally {
      await publisher.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not persist ordinary prompts and rejects a second active producer", async () => {
    const root = await mkdtemp(join(process.cwd(), ".provenloop-context-"));
    const now = new Date("2026-09-05T05:00:00.000Z");
    const options = {
      cwd: root,
      dataRoot: root,
      now: () => now,
      onError: (error: unknown) => { throw error; },
      sessionId: "session-1",
    };
    const publisher = new TrustedSessionContextPublisher(options);
    const duplicate = new TrustedSessionContextPublisher(options);
    try {
      await publisher.start();
      await expect(duplicate.start()).rejects.toThrow("active producer");
      publisher.observeUserMessage({
        eventId: "approval-1",
        text: "confirm PL-abcdef012345",
        timestamp: now.toISOString(),
      });
      await publisher.flush();
      publisher.observeUserMessage({
        eventId: "prompt-2",
        text: "Ordinary private project context must not be copied here.",
        timestamp: now.toISOString(),
      });
      await publisher.flush();
      const context = await readTrustedSessionContext(root, "session-1", now);
      expect(context?.latestUserMessage).toBeUndefined();
      const directory = join(root, "data", "session-context");
      const [name] = await readdir(directory);
      expect(name).toBeDefined();
      const body = await readFile(join(directory, name ?? ""), "utf8");
      expect(body).not.toContain("private project context");
      expect(body).not.toContain("prompt-2");
      expect(body).not.toContain("approval-1");
    } finally {
      await duplicate.stop();
      await publisher.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not reauthorize a stale snapshot when another producer acquires the Session", async () => {
    const root = await mkdtemp(join(process.cwd(), ".provenloop-context-restart-"));
    const now = new Date("2026-09-05T05:00:00.000Z");
    const options = {
      cwd: root,
      dataRoot: root,
      now: () => now,
      onError: (error: unknown) => { throw error; },
      sessionId: "session-restarted",
    };
    const first = new TrustedSessionContextPublisher(options);
    const second = new TrustedSessionContextPublisher(options);
    try {
      await first.start();
      first.observeUserMessage({
        eventId: "old-approval",
        text: "confirm PL-abcdef012345",
        timestamp: now.toISOString(),
      });
      await first.flush();
      const directory = join(root, "data", "session-context");
      const [name] = await readdir(directory);
      if (name === undefined) {
        throw new Error("Missing first producer snapshot.");
      }
      const path = join(directory, name);
      const previous = await readFile(path, "utf8");
      await first.stop();
      await second.start();
      const current = await readFile(path, "utf8");
      try {
        await writeFile(path, previous);
        for (let round = 0; round < 4; round += 1) {
          const contexts = await Promise.all(Array.from({ length: 64 }, () =>
            readTrustedSessionContext(root, "session-restarted", now)));
          expect(contexts.filter((context) => context !== undefined)).toEqual([]);
        }
      } finally {
        await writeFile(path, current);
      }
      expect(await readTrustedSessionContext(root, "session-restarted", now))
        .toBeDefined();
    } finally {
      await first.stop();
      await second.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed while another process holds the reader probe guard", async () => {
    const root = await mkdtemp(join(process.cwd(), ".provenloop-context-guard-"));
    const now = new Date("2026-09-05T05:00:00.000Z");
    const sessionId = "guarded-session";
    const publisher = new TrustedSessionContextPublisher({
      cwd: root, dataRoot: root, sessionId, now: () => now,
      onError: (error) => { throw error; },
    });
    let child: ReturnType<typeof spawn> | undefined;
    try {
      await publisher.start();
      const suffix = createHash("sha256").update(JSON.stringify([sessionId, null])).digest("hex").slice(0, 32);
      const pipePath = windowsNamedPipePath(await resolveWindowsProvenLoopLeaseName(
        root, `session-context-probe-${suffix}`,
      ));
      child = spawn(process.execPath, ["--input-type=module", "-e", `
        import { createServer } from "node:net";
        const server = createServer();
        server.listen(process.argv[1], () => process.send("ready"));
        process.on("message", () => server.close(() => process.exit(0)));
      `, pipePath], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
      await Promise.race([
        once(child, "message"),
        once(child, "exit").then(([code]) => { throw new Error(`Probe guard child exited: ${code}`); }),
      ]);
      expect(await readTrustedSessionContext(root, sessionId, now)).toBeUndefined();
      const exited = once(child, "exit");
      child.send("release");
      await exited;
      child = undefined;
      expect(await readTrustedSessionContext(root, sessionId, now)).toBeDefined();

      const directory = join(root, "data", "session-context");
      const [name] = await readdir(directory);
      if (name === undefined) throw new Error("Missing guarded producer snapshot.");
      const path = join(directory, name);
      const current = await readFile(path, "utf8");
      await writeFile(path, "{");
      await expect(readTrustedSessionContext(root, sessionId, now)).rejects.toThrow();
      await writeFile(path, current);
      expect(await readTrustedSessionContext(root, sessionId, now)).toBeDefined();
    } finally {
      if (child !== undefined && child.exitCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
      await publisher.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});
