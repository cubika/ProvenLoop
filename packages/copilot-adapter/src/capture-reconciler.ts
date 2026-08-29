import type { CaptureQueueItem } from "@provenloop/contracts";
import {
  createCaptureDeduplicationKey,
  sanitizeDiagnostic,
} from "@provenloop/domain";

import type { CaptureQueueSink } from "./async-writer.js";
import {
  CopilotEventMapper,
  type CopilotCallbackCopyLimits,
} from "./event-mapper.js";
import {
  parseCopilotSessionFile,
  type CopilotSessionFileHeader,
  type CopilotSessionFileIssue,
} from "./session-file-parser.js";

export interface ReconciliationQueue extends CaptureQueueSink {
  enqueueIfSourceAbsent(
    input: Parameters<CaptureQueueSink["enqueue"]>[0],
    options?: Parameters<CaptureQueueSink["enqueue"]>[1],
  ): Promise<{
    readonly status: "duplicate" | "enqueued";
  }>;
  list(): Promise<readonly CaptureQueueItem[]>;
}

export interface CanonicalCaptureWatermark {
  deduplicationKeys(
    adapter: string,
    adapterVersion: string,
    sessionId: string,
  ): Promise<ReadonlySet<string>>;
}

export interface CaptureReconcilerOptions {
  readonly canonical: CanonicalCaptureWatermark;
  readonly copyLimits: CopilotCallbackCopyLimits;
  readonly internalSessionIds?: ReadonlySet<string>;
  readonly maxLineChars: number;
  readonly onDiagnostic?: (message: string) => void;
  readonly queue: ReconciliationQueue;
}

export interface ReconcileSessionFileOptions {
  readonly expectedSessionId?: string;
  readonly path: string;
}

export type CaptureReconciliationResult =
  | {
      readonly adapterVersion: string;
      readonly duplicateEvents: number;
      readonly ignoredEvents: number;
      readonly malformedEvents: number;
      readonly parserIssues: number;
      readonly partialTail: boolean;
      readonly queuedEvents: number;
      readonly scannedEvents: number;
      readonly sessionId: string;
      readonly status: "reconciled";
      readonly unsupportedEvents: number;
    }
  | {
      readonly adapterVersion?: string;
      readonly fileVersion?: number;
      readonly reason:
        | "unsupported_adapter_version"
        | "unsupported_session_file_version";
      readonly status: "incompatible";
    }
  | {
      readonly lineNumber: number;
      readonly reason: string;
      readonly status: "malformed";
    }
  | {
      readonly adapterVersion: string;
      readonly sessionId: string;
      readonly status: "skipped_internal";
    }
  | {
      readonly error: string;
      readonly status: "failed";
    };

export class CaptureReconciler {
  readonly #canonical: CanonicalCaptureWatermark;
  readonly #copyLimits: CopilotCallbackCopyLimits;
  readonly #internalSessionIds: ReadonlySet<string>;
  readonly #maxLineChars: number;
  readonly #onDiagnostic: ((message: string) => void) | undefined;
  readonly #queue: ReconciliationQueue;

  public constructor(options: CaptureReconcilerOptions) {
    this.#canonical = options.canonical;
    this.#copyLimits = options.copyLimits;
    this.#internalSessionIds =
      options.internalSessionIds ?? new Set<string>();
    this.#maxLineChars = options.maxLineChars;
    this.#onDiagnostic = options.onDiagnostic;
    this.#queue = options.queue;
  }

  public async reconcileSessionFile(
    options: ReconcileSessionFileOptions,
  ): Promise<CaptureReconciliationResult> {
    let duplicateEvents = 0;
    let ignoredEvents = 0;
    let internalHeader: CopilotSessionFileHeader | undefined;
    let malformedEvents = 0;
    let mapper: CopilotEventMapper | undefined;
    let queuedEvents = 0;
    let scannedEvents = 0;
    let unsupportedEvents = 0;
    const known = new Set<string>();

    try {
      const parseResult = await parseCopilotSessionFile(options.path, {
        ...(options.expectedSessionId === undefined
          ? {}
          : {
              expectedSessionId: options.expectedSessionId,
            }),
        maxLineChars: this.#maxLineChars,
        onEvent: async (event) => {
          if (mapper === undefined) {
            throw new Error(
              "Session event arrived before a supported header.",
            );
          }
          scannedEvents += 1;
          const mapped = mapper.map(event);
          switch (mapped.status) {
            case "ignored":
              ignoredEvents += 1;
              return;
            case "malformed":
              malformedEvents += 1;
              this.#diagnostic(
                `Malformed Session event: ${mapped.issues.join(" ")}`,
              );
              return;
            case "unsupported":
              unsupportedEvents += 1;
              break;
            case "mapped":
              break;
          }
          const identity = createCaptureDeduplicationKey(
            mapped.value,
          );
          if (known.has(identity)) {
            duplicateEvents += 1;
            return;
          }
          const enqueued = await this.#queue.enqueueIfSourceAbsent(
            mapped.value,
            {
              environment: {},
            },
          );
          if (enqueued.status === "duplicate") {
            known.add(identity);
            duplicateEvents += 1;
            return;
          }
          known.add(identity);
          queuedEvents += 1;
        },
        onHeader: async (header) => {
          internalHeader = header;
          if (this.#internalSessionIds.has(header.sessionId)) {
            return false;
          }
          mapper = new CopilotEventMapper({
            adapterVersion: header.adapterVersion,
            copyLimits: this.#copyLimits,
            sessionId: header.sessionId,
            workspace: header.workspace,
          });
          const [queueItems, canonicalDeduplicationKeys] =
            await Promise.all([
              this.#queue.list(),
              this.#canonical.deduplicationKeys(
                "copilot-cli",
                header.adapterVersion,
                header.sessionId,
              ),
            ]);
          for (const item of queueItems) {
            const envelope = item.envelope;
            if (
              envelope.event.adapter === "copilot-cli" &&
              envelope.event.adapterVersion ===
                header.adapterVersion &&
              envelope.event.sessionId === header.sessionId
            ) {
              known.add(envelope.deduplicationKey);
            }
          }
          for (const deduplicationKey of canonicalDeduplicationKeys) {
            known.add(deduplicationKey);
          }
          return true;
        },
        onIssue: (issue) => {
          this.#reportParserIssue(issue);
        },
      });

      if (parseResult.status === "incompatible") {
        return parseResult;
      }
      if (parseResult.status === "malformed") {
        return parseResult;
      }
      if (
        internalHeader !== undefined &&
        parseResult.stoppedAfterHeader
      ) {
        return {
          status: "skipped_internal",
          adapterVersion: internalHeader.adapterVersion,
          sessionId: internalHeader.sessionId,
        };
      }
      return {
        status: "reconciled",
        adapterVersion: parseResult.header.adapterVersion,
        duplicateEvents,
        ignoredEvents,
        malformedEvents,
        parserIssues: parseResult.issueCount,
        partialTail: parseResult.partialTail,
        queuedEvents,
        scannedEvents,
        sessionId: parseResult.header.sessionId,
        unsupportedEvents,
      };
    } catch (error) {
      const safeError = sanitizeDiagnostic(error);
      this.#diagnostic(safeError);
      return {
        status: "failed",
        error: safeError,
      };
    }
  }

  #reportParserIssue(issue: CopilotSessionFileIssue): void {
    this.#diagnostic(
      `Session file ${issue.kind} at line ${issue.lineNumber}: ${issue.message}`,
    );
  }

  #diagnostic(value: unknown): void {
    if (this.#onDiagnostic === undefined) {
      return;
    }
    try {
      this.#onDiagnostic(sanitizeDiagnostic(value));
    } catch {
      // Diagnostics cannot interrupt reconciliation.
    }
  }
}
