import { performance } from "node:perf_hooks";

import { sanitizeDiagnostic } from "@provenloop/domain";

import {
  AsyncCaptureWriter,
  type CaptureWriterStatus,
} from "./async-writer.js";
import {
  CopilotEventMapper,
  type CopilotEventMappingResult,
  type CopilotSessionEvent,
  type CopilotWorkspaceSnapshot,
} from "./event-mapper.js";

export interface CopilotSessionLike {
  on(listener: (event: CopilotSessionEvent) => void): unknown;
  disconnect?(): Promise<void> | void;
}

export interface CopilotExtensionCaptureOptions {
  readonly internalSession: boolean;
  readonly mapper: CopilotEventMapper;
  readonly onDiagnostic?: (message: string) => void;
  readonly onStopped?: () => Promise<void> | void;
  readonly refreshWorkspace?: () => Promise<CopilotWorkspaceSnapshot>;
  readonly shutdownDeadlineMs: number;
  readonly writer: AsyncCaptureWriter;
}

export interface CopilotExtensionCaptureStatus {
  readonly callbackCount: number;
  readonly callbackDurationMaxMs: number;
  readonly callbackDurationSamplesMs: readonly number[];
  readonly callbackDurationTotalMs: number;
  readonly disabledEventsSkipped: number;
  readonly ignoredEvents: number;
  readonly internalEventsSkipped: number;
  readonly malformedEvents: number;
  readonly runtimeErrors: number;
  readonly unsupportedEvents: number;
  readonly workspaceRefreshFailures: number;
  readonly writer: CaptureWriterStatus;
}

export class InvalidExtensionCaptureConfigurationError extends Error {
  public override readonly name =
    "InvalidExtensionCaptureConfigurationError";

  public constructor() {
    super("Extension shutdownDeadlineMs must be a positive integer.");
  }
}

const asPendingGitContext = (data: unknown): boolean | undefined => {
  if (data === null || typeof data !== "object") {
    return undefined;
  }
  const pending = (
    data as Readonly<Record<string, unknown>>
  ).pendingGitContext;
  return typeof pending === "boolean" ? pending : undefined;
};

export class CopilotExtensionCapture {
  #callbackCount = 0;
  #callbackDurationMaxMs = 0;
  readonly #callbackDurationSamplesMs: number[] = [];
  #callbackDurationTotalMs = 0;
  #disabledEventsSkipped = 0;
  #enabled = true;
  #ignoredEvents = 0;
  readonly #internalSession: boolean;
  #internalEventsSkipped = 0;
  readonly #mapper: CopilotEventMapper;
  #malformedEvents = 0;
  readonly #onDiagnostic: ((message: string) => void) | undefined;
  readonly #onStopped: (() => Promise<void> | void) | undefined;
  readonly #refreshWorkspace:
    (() => Promise<CopilotWorkspaceSnapshot>) | undefined;
  #activeRefresh: Promise<void> | undefined;
  #closing = false;
  #refreshWorkspacePending = false;
  #refreshingWorkspace = false;
  #runtimeErrors = 0;
  readonly #shutdownDeadlineMs: number;
  #shutdownPromise: Promise<boolean> | undefined;
  #stoppedNotification: Promise<void> | undefined;
  #started = false;
  #unsupportedEvents = 0;
  #workspaceGeneration = 0;
  #workspaceRefreshFailures = 0;
  readonly #writer: AsyncCaptureWriter;

  public constructor(options: CopilotExtensionCaptureOptions) {
    if (
      !Number.isInteger(options.shutdownDeadlineMs) ||
      options.shutdownDeadlineMs <= 0
    ) {
      throw new InvalidExtensionCaptureConfigurationError();
    }
    this.#internalSession = options.internalSession;
    this.#mapper = options.mapper;
    this.#onDiagnostic = options.onDiagnostic;
    this.#onStopped = options.onStopped;
    this.#refreshWorkspace = options.refreshWorkspace;
    this.#shutdownDeadlineMs = options.shutdownDeadlineMs;
    this.#writer = options.writer;
  }

  public attach(session: CopilotSessionLike): void {
    this.start();
    session.on((event) => {
      this.receive(event);
    });
  }

  public start(): void {
    if (this.#started) {
      return;
    }
    this.#started = true;
    if (!this.#internalSession) {
      this.#writer.submit(this.#mapper.sessionStarted());
    }
  }

  public receive(
    event: CopilotSessionEvent,
  ): CopilotEventMappingResult {
    this.start();
    const result = this.handle(event);
    if (event.type === "session.shutdown") {
      void this.shutdown();
    }
    return result;
  }

  public handle(event: CopilotSessionEvent): CopilotEventMappingResult {
    const startedAt = performance.now();
    try {
      if (!this.#enabled) {
        this.#disabledEventsSkipped += 1;
        return {
          status: "ignored",
          reason: "capability_disabled",
        };
      }
      if (this.#internalSession) {
        this.#internalEventsSkipped += 1;
        return {
          status: "ignored",
          reason: "internal_session",
        };
      }
      const result = this.#mapper.map(event);
      if (
        event.type === "session.context_changed" &&
        result.status === "unsupported" &&
        asPendingGitContext(event.data) !== true
      ) {
        this.#workspaceGeneration += 1;
      }
      switch (result.status) {
        case "ignored":
          this.#ignoredEvents += 1;
          break;
        case "malformed":
          this.#malformedEvents += 1;
          this.#diagnostic(
            `Malformed Copilot event: ${result.issues.join(" ")}`,
          );
          break;
        case "mapped":
          this.#writer.submit(result.value);
          break;
        case "unsupported":
          this.#unsupportedEvents += 1;
          this.#writer.submit(result.value);
          break;
      }
      if (event.type === "tool.execution_complete") {
        this.#scheduleWorkspaceRefresh();
      }
      return result;
    } catch (error) {
      this.#runtimeErrors += 1;
      this.#diagnostic(error);
      return {
        status: "malformed",
        issues: [
          "Extension callback failed while copying the event.",
        ],
      };
    } finally {
      const duration = performance.now() - startedAt;
      this.#callbackCount += 1;
      this.#callbackDurationTotalMs += duration;
      this.#callbackDurationMaxMs = Math.max(
        this.#callbackDurationMaxMs,
        duration,
      );
      if (this.#callbackDurationSamplesMs.length < 10_000) {
        this.#callbackDurationSamplesMs.push(duration);
      } else {
        this.#callbackDurationSamplesMs[
          (this.#callbackCount - 1) %
            this.#callbackDurationSamplesMs.length
        ] = duration;
      }
    }
  }

  public updateWorkspace(snapshot: CopilotWorkspaceSnapshot): void {
    this.#workspaceGeneration += 1;
    const commitEvent = this.#mapper.updateWorkspace(snapshot);
    if (commitEvent !== undefined) {
      this.#writer.submit(commitEvent);
    }
  }

  public setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
  }

  public refreshWorkspace(): void {
    if (this.#closing) {
      return;
    }
    this.#scheduleWorkspaceRefresh();
  }

  public shutdown(): Promise<boolean> {
    this.#shutdownPromise ??= this.#shutdownWithinDeadline()
      .finally(() => this.#notifyStopped());
    return this.#shutdownPromise;
  }

  public status(): CopilotExtensionCaptureStatus {
    return {
      callbackCount: this.#callbackCount,
      callbackDurationMaxMs: this.#callbackDurationMaxMs,
      callbackDurationSamplesMs: [
        ...this.#callbackDurationSamplesMs,
      ],
      callbackDurationTotalMs: this.#callbackDurationTotalMs,
      disabledEventsSkipped: this.#disabledEventsSkipped,
      ignoredEvents: this.#ignoredEvents,
      internalEventsSkipped: this.#internalEventsSkipped,
      malformedEvents: this.#malformedEvents,
      runtimeErrors: this.#runtimeErrors,
      unsupportedEvents: this.#unsupportedEvents,
      workspaceRefreshFailures: this.#workspaceRefreshFailures,
      writer: this.#writer.status(),
    };
  }

  #scheduleWorkspaceRefresh(allowDuringClosing = false): void {
    if (
      (this.#closing && !allowDuringClosing) ||
      this.#refreshWorkspace === undefined
    ) {
      return;
    }
    if (this.#refreshingWorkspace) {
      this.#refreshWorkspacePending = true;
      return;
    }
    const refreshWorkspace = this.#refreshWorkspace;
    const refreshGeneration = this.#workspaceGeneration;
    this.#refreshingWorkspace = true;
    const activeRefresh = new Promise<void>((resolve) => {
      setImmediate(() => {
        void refreshWorkspace()
        .then((snapshot) => {
          if (this.#workspaceGeneration === refreshGeneration) {
            const commitEvent =
              this.#mapper.updateWorkspace(snapshot);
            if (commitEvent !== undefined) {
              this.#writer.submit(commitEvent);
            }
          } else {
            const current = this.#mapper.currentWorkspace();
            if (
              snapshot.commitSha !== undefined &&
              snapshot.commitSha === current.commitSha &&
              snapshot.commitParents !== undefined
            ) {
              const commitEvent = this.#mapper.updateWorkspace({
                ...current,
                commitParents: snapshot.commitParents,
              });
              if (commitEvent !== undefined) {
                this.#writer.submit(commitEvent);
              }
            } else if (
              snapshot.commitSha !== undefined &&
              snapshot.commitSha !== current.commitSha
            ) {
              this.#refreshWorkspacePending = true;
            }
          }
        })
        .catch((error: unknown) => {
          this.#workspaceRefreshFailures += 1;
          this.#diagnostic(error);
        })
        .finally(() => {
          this.#refreshingWorkspace = false;
          if (this.#refreshWorkspacePending) {
            this.#refreshWorkspacePending = false;
            this.#scheduleWorkspaceRefresh(true);
          }
          resolve();
        });
      });
    });
    this.#activeRefresh = activeRefresh;
    void activeRefresh.finally(() => {
      if (this.#activeRefresh === activeRefresh) {
        this.#activeRefresh = undefined;
      }
    });
  }

  async #shutdownWithinDeadline(): Promise<boolean> {
    this.#closing = true;
    const deadline = Date.now() + this.#shutdownDeadlineMs;
    let refreshesSettled = true;
    while (
      this.#activeRefresh !== undefined ||
      this.#refreshingWorkspace ||
      this.#refreshWorkspacePending
    ) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        refreshesSettled = false;
        break;
      }
      const activeRefresh = this.#activeRefresh;
      if (activeRefresh === undefined) {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        continue;
      }
      const settled = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          resolve(false);
        }, remaining);
        void activeRefresh.finally(() => {
          clearTimeout(timer);
          resolve(true);
        });
      });
      if (!settled) {
        refreshesSettled = false;
        break;
      }
    }
    const remaining = Math.max(1, deadline - Date.now());
    const writerSettled = await this.#writer.stop(remaining);
    return refreshesSettled && writerSettled;
  }

  #notifyStopped(): Promise<void> {
    this.#stoppedNotification ??= Promise.resolve(
      this.#onStopped?.(),
    ).catch((error: unknown) => {
      this.#diagnostic(error);
    });
    return this.#stoppedNotification;
  }

  #diagnostic(value: unknown): void {
    if (this.#onDiagnostic === undefined) {
      return;
    }
    try {
      this.#onDiagnostic(sanitizeDiagnostic(value));
    } catch {
      // Diagnostics cannot affect Copilot event handling.
    }
  }

}
