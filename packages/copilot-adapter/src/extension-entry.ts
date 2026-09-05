import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  dirname,
  join,
} from "node:path";

import {
  ExtensionShutdownRequestedError,
  isExtensionShutdownRequested,
  registerActiveExtension,
  resolveWindowsProvenLoopPaths,
  WindowsCaptureQueue,
} from "@provenloop/platform-windows";

import { getCopilotCaptureCapability } from "./capabilities.js";
import type { CommandRunner } from "./command-runner.js";
import {
  assertCopilotAdapterDataRoot,
  CopilotCliAdapter,
} from "./copilot-cli-adapter.js";
import type { CopilotSessionLike } from "./extension-runtime.js";
import { readCopilotAdapterState } from "./operational-state.js";
import { startCopilotExtensionCapture } from "./start-extension.js";

export interface InstalledCopilotExtensionOptions {
  readonly commandRunner?: CommandRunner;
  readonly copilotHome?: string;
  readonly dataRoot: string;
  readonly environment?: Readonly<
    Record<string, string | undefined>
  >;
  readonly joinSession: () => Promise<CopilotSessionLike>;
  readonly now?: () => Date;
}

export type InstalledCopilotExtensionResult =
  | {
      readonly status: "disabled" | "incompatible";
    }
  | {
      readonly status: "failed";
      readonly error: string;
    }
  | {
      readonly status: "started";
    };

const appendDiagnostic = async (
  path: string,
  message: string,
): Promise<void> => {
  await mkdir(dirname(path), {
    recursive: true,
  });
  await appendFile(
    path,
    `${JSON.stringify({
      message,
      timestamp: new Date().toISOString(),
    })}\n`,
    "utf8",
  );
};

const writeCaptureMetrics = async (
  path: string,
  value: unknown,
): Promise<void> => {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), {
    recursive: true,
  });
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify(value)}\n`,
      "utf8",
    );
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
};

export const runInstalledCopilotExtension = async (
  options: InstalledCopilotExtensionOptions,
): Promise<InstalledCopilotExtensionResult> => {
  const now = options.now ?? (() => new Date());
  const environment = options.environment ?? process.env;
  const paths = resolveWindowsProvenLoopPaths(options.dataRoot);
  let runtimeActive = true;
  let extensionRegistration:
    | Awaited<ReturnType<typeof registerActiveExtension>>
    | undefined;
  let metricsTimer: NodeJS.Timeout | undefined;
  let dataRootVerified = false;
  const releaseExtensionRegistration = async (): Promise<void> => {
    await extensionRegistration?.release();
    extensionRegistration = undefined;
  };
  const diagnostic = (message: string): void => {
    if (!runtimeActive) {
      return;
    }
    void appendDiagnostic(
      join(paths.logs, "extension.jsonl"),
      message,
    ).catch(() => undefined);
  };
  try {
    await assertCopilotAdapterDataRoot(paths);
    dataRootVerified = true;
    const sessionId = environment.SESSION_ID?.trim();
    if (!sessionId) {
      throw new Error("SESSION_ID is unavailable to the Extension.");
    }
    extensionRegistration = await registerActiveExtension(
      paths.root,
      sessionId,
      {
        assertDataRoot: () =>
          assertCopilotAdapterDataRoot(paths),
      },
    );
    const state = await readCopilotAdapterState(
      paths.adapterState,
      now(),
    );
    if (!state.capabilities.capture.enabled) {
      await releaseExtensionRegistration();
      return {
        status: "disabled",
      };
    }
    const adapter = new CopilotCliAdapter({
      ...(options.commandRunner === undefined
        ? {}
        : {
            commandRunner: options.commandRunner,
          }),
      ...(options.copilotHome === undefined
        ? {}
        : {
            copilotHome: options.copilotHome,
          }),
      dataRoot: options.dataRoot,
      environment,
      now,
    });
    const capabilities = await adapter.capabilities();
    const adapterVersion = capabilities.installedVersion;
    if (
      capabilities.compatibility !== "supported" ||
      adapterVersion === undefined ||
      getCopilotCaptureCapability(adapterVersion) === undefined
    ) {
      diagnostic(
        `Copilot version ${adapterVersion ?? "unknown"} is incompatible.`,
      );
      await releaseExtensionRegistration();
      return {
        status: "incompatible",
      };
    }
    const identity = await adapter.resolveSession({
      adapterVersion,
      cwd: process.cwd(),
      environment,
      sessionId,
    });
    if (identity.internalSession) {
      await releaseExtensionRegistration();
      return {
        status: "disabled",
      };
    }
    const queue = new WindowsCaptureQueue(paths.queue);
    await queue.initialize();
    const stopRuntime = async (): Promise<void> => {
      runtimeActive = false;
      if (metricsTimer !== undefined) {
        clearInterval(metricsTimer);
        metricsTimer = undefined;
      }
      await releaseExtensionRegistration();
    };
    const capture = await startCopilotExtensionCapture({
      adapterVersion,
      buffer: {
        maxBytes: 1024 * 1024,
        maxGapBytes: 128 * 1024,
        maxGapContexts: 64,
        maxItems: 1_000,
      },
      copyLimits: {
        maxStringChars: 32_768,
      },
      environment,
      joinSession: async ({ onEvent }) => {
        const session = await options.joinSession();
        session.on(onEvent);
        return session;
      },
      onDiagnostic: diagnostic,
      onStopped: stopRuntime,
      queue,
      refreshWorkspace: async () => {
        const refreshed = await adapter.resolveSession({
          adapterVersion,
          cwd: process.cwd(),
          environment,
          sessionId,
        });
        return {
          ...(refreshed.branch === undefined
            ? {}
            : {
                branch: refreshed.branch,
              }),
          ...(refreshed.commitParents === undefined
            ? {}
            : {
                commitParents: refreshed.commitParents,
              }),
          ...(refreshed.commitSha === undefined
            ? {}
            : {
                commitSha: refreshed.commitSha,
              }),
          ...(refreshed.repositoryId === undefined
            ? {}
            : {
                repoId: refreshed.repositoryId,
              }),
          ...(refreshed.worktreePath === undefined
            ? {}
            : {
                worktreePath: refreshed.worktreePath,
              }),
        };
      },
      retryDelayMs: 1_000,
      sessionId,
      shutdownDeadlineMs: 5_000,
      workspace: {
        ...(identity.branch === undefined
          ? {}
          : {
              branch: identity.branch,
            }),
        ...(identity.commitSha === undefined
          ? {}
          : {
              commitSha: identity.commitSha,
            }),
        ...(identity.commitParents === undefined
          ? {}
          : {
              commitParents: identity.commitParents,
            }),
        ...(identity.repositoryId === undefined
          ? {}
          : {
              repoId: identity.repositoryId,
            }),
        ...(identity.worktreePath === undefined
          ? {}
          : {
              worktreePath: identity.worktreePath,
            }),
      },
    });
    const sessionDigest = createHash("sha256")
      .update(sessionId)
      .digest("hex")
      .slice(0, 24);
    const metricsPath = join(
      paths.evaluation,
      "capture-metrics",
      `${sessionDigest}.json`,
    );
    let metricsFlushRunning = false;
    const flushMetrics = async (): Promise<void> => {
      if (metricsFlushRunning) {
        return;
      }
      metricsFlushRunning = true;
      let latest: Awaited<
        ReturnType<typeof readCopilotAdapterState>
      >;
      try {
        if (await isExtensionShutdownRequested(paths.root)) {
          capture.setEnabled(false);
          await capture.shutdown();
          metricsFlushRunning = false;
          return;
        }
        latest = await readCopilotAdapterState(
          paths.adapterState,
          now(),
        );
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
        ) {
          diagnostic(
            `Capture capability refresh failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        runtimeActive = false;
        capture.setEnabled(false);
        if (metricsTimer !== undefined) {
          clearInterval(metricsTimer);
          metricsTimer = undefined;
        }
        await capture.shutdown().catch(() => false);
        metricsFlushRunning = false;
        return;
      }
      if (!latest.capabilities.capture.enabled) {
        runtimeActive = false;
        capture.setEnabled(false);
        if (metricsTimer !== undefined) {
          clearInterval(metricsTimer);
          metricsTimer = undefined;
        }
        await capture.shutdown().catch(() => false);
        metricsFlushRunning = false;
        return;
      }
      capture.setEnabled(true);
      try {
        await writeCaptureMetrics(metricsPath, {
          schemaVersion: 1,
          sessionIdDigest: sessionDigest,
          status: capture.status(),
          timestamp: now().toISOString(),
        });
      } catch (error) {
        if (runtimeActive) {
          diagnostic(
            `Capture metrics write failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      } finally {
        metricsFlushRunning = false;
      }
    };
    metricsTimer = setInterval(() => {
      void flushMetrics();
    }, 1_000);
    metricsTimer.unref();
    void flushMetrics();
    return {
      status: "started",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof ExtensionShutdownRequestedError) {
      runtimeActive = false;
      return {
        status: "disabled",
      };
    }
    await releaseExtensionRegistration();
    if (
      dataRootVerified &&
      extensionRegistration !== undefined
    ) {
      diagnostic(message);
    } else {
      runtimeActive = false;
    }
    return {
      error: message,
      status: "failed",
    };
  }
};
