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
  const result = await runInstalledCopilotExtension(options);
  if (result.status !== "started") {
    return result;
  }
  let workerRunning = false;
  const schedule = (delayMs: number): void => {
    const timer = setTimeout(drainWorker, delayMs);
    timer.unref();
  };
  const drainWorker = (): void => {
    if (workerRunning) {
      return;
    }
    workerRunning = true;
    void runCaptureWorkerOnce({
      dataRoot: options.dataRoot,
    })
      .then((workerResult) => {
        const active =
          workerResult.status === "completed" &&
          (
            workerResult.acknowledged > 0 ||
            workerResult.deadLettered > 0 ||
            workerResult.retried > 0
          );
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
