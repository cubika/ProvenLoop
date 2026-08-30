import { appendFile, mkdir } from "node:fs/promises";
import {
  dirname,
  join,
} from "node:path";

import {
  resolveWindowsProvenLoopPaths,
  WindowsCaptureQueue,
} from "@provenloop/platform-windows";

import { getCopilotCaptureCapability } from "./capabilities.js";
import type { CommandRunner } from "./command-runner.js";
import { CopilotCliAdapter } from "./copilot-cli-adapter.js";
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

export const runInstalledCopilotExtension = async (
  options: InstalledCopilotExtensionOptions,
): Promise<InstalledCopilotExtensionResult> => {
  const now = options.now ?? (() => new Date());
  const environment = options.environment ?? process.env;
  const paths = resolveWindowsProvenLoopPaths(options.dataRoot);
  const diagnostic = (message: string): void => {
    void appendDiagnostic(
      join(paths.logs, "extension.jsonl"),
      message,
    ).catch(() => undefined);
  };
  try {
    const state = await readCopilotAdapterState(
      paths.adapterState,
      now(),
    );
    if (!state.capabilities.capture.enabled) {
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
      return {
        status: "incompatible",
      };
    }
    const sessionId = environment.SESSION_ID?.trim();
    if (!sessionId) {
      throw new Error("SESSION_ID is unavailable to the Extension.");
    }
    const identity = await adapter.resolveSession({
      adapterVersion,
      cwd: process.cwd(),
      environment,
      sessionId,
    });
    if (identity.internalSession) {
      return {
        status: "disabled",
      };
    }
    const queue = new WindowsCaptureQueue(paths.queue);
    await queue.initialize();
    await startCopilotExtensionCapture({
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
    return {
      status: "started",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    diagnostic(message);
    return {
      error: message,
      status: "failed",
    };
  }
};
