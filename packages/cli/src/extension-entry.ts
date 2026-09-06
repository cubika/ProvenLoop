import {
  runInstalledCopilotExtension,
  type InstalledCopilotExtensionOptions,
  type InstalledCopilotExtensionResult,
} from "@provenloop/copilot-adapter";
import {
  sanitizeDiagnostic,
} from "@provenloop/domain";

import {
  runCaptureWorkerOnce,
} from "./run-worker.js";
import { collectLocalObservations } from "./collect-observations.js";
import { reconcileCurrentSessionCapture } from "./reconcile-capture.js";

export type {
  InstalledCopilotExtensionOptions,
  InstalledCopilotExtensionResult,
};
export {
  runInstalledCopilotExtension,
};

export const runProvenLoopCopilotExtension = async (
  options: InstalledCopilotExtensionOptions,
): Promise<InstalledCopilotExtensionResult> => {
  let workerRunning = false;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let nextObservationAt = 0;
  const stopScheduling = (): void => {
    stopped = true;
    clearTimeout(timer);
    process.removeListener("SIGTERM", stopScheduling);
  };
  const result = await runInstalledCopilotExtension({
    ...options,
    onStopped: () => {
      stopScheduling();
      options.onStopped?.();
    },
  });
  if (result.status !== "started" || stopped) {
    return result;
  }
  (options.signalSource ?? process).once("SIGTERM", stopScheduling);
  const schedule = (delayMs: number): void => {
    if (stopped) {
      return;
    }
    timer = setTimeout(drainWorker, delayMs);
    timer.unref();
  };
  const drainWorker = (): void => {
    if (workerRunning || stopped) {
      return;
    }
    workerRunning = true;
    void runCaptureWorkerOnce({
      dataRoot: options.dataRoot,
    })
      .then(async (workerResult) => {
        let observationPending = false;
        if (
          !stopped &&
          workerResult.status === "completed" &&
          Date.now() >= nextObservationAt
        ) {
          nextObservationAt = Date.now() + 30_000;
          if (result.captureSession !== undefined) {
            try {
              const reconciliation = await reconcileCurrentSessionCapture({
                dataRoot: options.dataRoot,
                ...result.captureSession,
                ...(options.now === undefined ? {} : { now: options.now }),
              });
              if (reconciliation.status === "reconciled" || reconciliation.status === "budget_exhausted") {
                const detail = reconciliation.reconciliation;
                observationPending =
                  reconciliation.status === "budget_exhausted" ||
                  reconciliation.enrichedEvents > 0 ||
                  ("queuedEvents" in detail && detail.queuedEvents > 0);
                for (const message of reconciliation.diagnostics) {
                  console.error(`ProvenLoop capture reconciliation: ${sanitizeDiagnostic(message)}`);
                }
              } else if ("reason" in reconciliation && reconciliation.status !== "skipped") {
                console.error(
                  `ProvenLoop capture reconciliation ${reconciliation.status}: ${reconciliation.reason}`,
                );
              }
            } catch (error) {
              console.error(`ProvenLoop capture reconciliation failed: ${sanitizeDiagnostic(error)}`);
            }
          }
          if (stopped) return;
          try {
            const observation = await collectLocalObservations({
              dataRoot: options.dataRoot,
            });
            observationPending ||= observation.pending;
          } catch (error) {
            console.error(
              `ProvenLoop local observation failed: ${sanitizeDiagnostic(error)}`,
            );
          }
          if (observationPending) nextObservationAt = Date.now() + 2_000;
        }
        const active =
          observationPending ||
          (workerResult.status === "completed" &&
          (
            workerResult.acknowledged > 0 ||
            workerResult.deadLettered > 0 ||
            workerResult.retried > 0
          ));
        schedule(active ? 2_000 : 30_000);
      })
      .catch((error: unknown) => {
        console.error(
          `ProvenLoop background worker failed: ${
            sanitizeDiagnostic(error)
          }`,
        );
        schedule(30_000);
      })
      .finally(() => {
        workerRunning = false;
      });
  };
  drainWorker();
  return result;
};
