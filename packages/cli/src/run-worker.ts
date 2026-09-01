import { randomUUID } from "node:crypto";
import {
  access,
  rename,
  statfs,
  unlink,
  writeFile,
} from "node:fs/promises";
import { availableParallelism } from "node:os";

import {
  assertCopilotAdapterDataRoot,
  readCopilotAdapterState,
} from "@provenloop/copilot-adapter";
import { sanitizeDiagnostic } from "@provenloop/domain";
import {
  BranchContextProjector,
  CaptureWorker,
  CaptureWorkerCircuitBreaker,
  CorrectionCaptureProjector,
  KnowledgeLifecycleProjector,
  WorkEpisodeProjector,
  type CaptureWorkerRunResult,
} from "@provenloop/host";
import {
  resolveWindowsCaptureWorkerLeaseName,
  resolveWindowsProvenLoopLeaseName,
  resolveWindowsProvenLoopPaths,
  WindowsCaptureQueue,
  WindowsNamedPipeLeaseProvider,
  type ProcessLease,
  type ProcessLeaseProvider,
} from "@provenloop/platform-windows";
import {
  KnowledgeProjectionManager,
  SqliteFtsKnowledgeBackend,
} from "@provenloop/retrieval";
import {
  CanonicalSqliteStore,
} from "@provenloop/storage-sqlite";

export interface RunCaptureWorkerOnceOptions {
  readonly batchSize?: number;
  readonly dataRoot: string;
  readonly lease?: ProcessLeaseProvider;
  readonly now?: () => Date;
  readonly workerId?: string;
}

const defaultCircuitBreaker = (): CaptureWorkerCircuitBreaker =>
  new CaptureWorkerCircuitBreaker({
    maxConsecutiveProviderErrors: 3,
    maxCpuPercent: 80,
    maxMemoryBytes: 512 * 1024 * 1024,
    maxQueueDepth: 10_000,
    minFreeDiskBytes: 512 * 1024 * 1024,
  });

const acquireRequiredLease = async (
  provider: ProcessLeaseProvider,
): Promise<ProcessLease> => {
  let lease = await provider.tryAcquire();
  while (lease === undefined) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
    lease = await provider.tryAcquire();
  }
  return lease;
};

const writeHeartbeat = async (
  path: string,
  input: {
    readonly correctionCaptureIssueCount?: number;
    readonly correctionCaptureIssues?: readonly string[];
    readonly correctionProjectionError?: string;
    readonly knowledgeLifecycleProjectionError?: string;
    readonly knowledgeProjectionError?: string;
    readonly result: CaptureWorkerRunResult;
    readonly timestamp: string;
    readonly workerId: string;
  },
): Promise<void> => {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify({
        schemaVersion: 1,
        ...input,
      })}\n`,
      "utf8",
    );
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
};

export const runCaptureWorkerOnce = async (
  options: RunCaptureWorkerOnceOptions,
): Promise<CaptureWorkerRunResult> => {
  const now = options.now ?? (() => new Date());
  const paths = resolveWindowsProvenLoopPaths(options.dataRoot);
  await assertCopilotAdapterDataRoot(paths);
  await access(paths.database);
  const workerId =
    options.workerId ?? `worker-${process.pid}-${randomUUID()}`;
  const leaseProvider =
    options.lease ??
    new WindowsNamedPipeLeaseProvider(
      await resolveWindowsCaptureWorkerLeaseName(paths.root),
    );
  const workerLease = await leaseProvider.tryAcquire();
  if (workerLease === undefined) {
    return {
      status: "lease_unavailable",
    };
  }
  let store: CanonicalSqliteStore | undefined;
  let knowledgeBackend: SqliteFtsKnowledgeBackend | undefined;
  const queue = new WindowsCaptureQueue(paths.queue);
  const breaker = defaultCircuitBreaker();
  let previousCpu = process.cpuUsage();
  let previousCpuAt = process.hrtime.bigint();
  try {
    await queue.initialize();
    store = new CanonicalSqliteStore(paths.database);
    const result = await new CaptureWorker({
      admission: async () => {
        const currentCpuAt = process.hrtime.bigint();
        const elapsedMicroseconds =
          Number(currentCpuAt - previousCpuAt) / 1_000;
        const currentCpu = process.cpuUsage();
        const usedMicroseconds =
          currentCpu.user - previousCpu.user +
          currentCpu.system - previousCpu.system;
        previousCpu = currentCpu;
        previousCpuAt = currentCpuAt;
        const filesystem = await statfs(paths.root);
        const queueDepth = (await queue.list()).filter(
          (item) =>
            item.state === "pending" ||
            item.state === "claimed" ||
            item.state === "retry",
        ).length;
        return breaker.evaluate({
          consecutiveProviderErrors: 0,
          cpuPercent:
            elapsedMicroseconds <= 0
              ? 0
              : usedMicroseconds /
                elapsedMicroseconds /
                availableParallelism() *
                100,
          freeDiskBytes:
            Number(filesystem.bavail) *
            Number(filesystem.bsize),
          memoryBytes: process.memoryUsage().rss,
          queueDepth,
        });
      },
      batchSize: options.batchSize ?? 100,
      enabled: async () =>
        (
          await readCopilotAdapterState(
            paths.adapterState,
            now(),
          )
        ).capabilities.worker.enabled,
      lease: {
        tryAcquire: async () => ({
          release: async () => undefined,
        }),
      },
      queue,
      store,
      workerId,
    }).runOnce();
    const adapterState =
      result.status === "completed"
        ? await readCopilotAdapterState(
            paths.adapterState,
            now(),
          )
        : undefined;
    let correctionCaptureIssueCount: number | undefined;
    let correctionCaptureIssues: readonly string[] | undefined;
    let correctionProjectionError: string | undefined;
    let knowledgeLifecycleProjectionError: string | undefined;
    if (result.status === "completed") {
      new WorkEpisodeProjector({
        store,
      }).rebuild();
      if (
        adapterState?.capabilities.correction_learning.enabled === true
      ) {
        try {
          const correctionProjection =
            new CorrectionCaptureProjector({
              store,
            }).rebuild();
          correctionCaptureIssueCount =
            correctionProjection.issues.length;
          correctionCaptureIssues = correctionProjection.issues
            .slice(0, 20)
            .map((item) =>
              sanitizeDiagnostic(
                `${item.eventId}: ${item.message}`,
              ),
            );
        } catch (error) {
          correctionProjectionError = sanitizeDiagnostic(error);
        }
        if (correctionProjectionError === undefined) {
          try {
            new KnowledgeLifecycleProjector({
              store,
            }).rebuild();
          } catch (error) {
            knowledgeLifecycleProjectionError =
              sanitizeDiagnostic(error);
          }
        }
      }
      new BranchContextProjector({
        store,
      }).rebuild();
    }
    let knowledgeProjectionError: string | undefined;
    if (
      result.status === "completed" &&
      adapterState?.capabilities.retrieval.enabled === true
    ) {
      try {
        knowledgeBackend = new SqliteFtsKnowledgeBackend(
          paths.knowledgeDatabase,
        );
        const knowledgeLease = await acquireRequiredLease(
          new WindowsNamedPipeLeaseProvider(
            await resolveWindowsProvenLoopLeaseName(
              paths.root,
              "knowledge-projection",
            ),
          ),
        );
        try {
          await new KnowledgeProjectionManager({
            backend: knowledgeBackend,
            store,
          }).rebuild();
        } finally {
          await knowledgeLease.release();
        }
      } catch (error) {
        knowledgeProjectionError = sanitizeDiagnostic(error);
      } finally {
        knowledgeBackend?.close();
        knowledgeBackend = undefined;
      }
    }
    store.close();
    store = undefined;
    await writeHeartbeat(paths.heartbeat, {
      ...(correctionCaptureIssueCount === undefined
        ? {}
        : {
            correctionCaptureIssueCount,
          }),
      ...(correctionCaptureIssues === undefined
        ? {}
        : {
            correctionCaptureIssues,
          }),
      ...(correctionProjectionError === undefined
        ? {}
        : {
            correctionProjectionError,
          }),
      ...(knowledgeProjectionError === undefined
        ? {}
        : {
            knowledgeProjectionError,
          }),
      ...(knowledgeLifecycleProjectionError === undefined
        ? {}
        : {
            knowledgeLifecycleProjectionError,
          }),
      result,
      timestamp: now().toISOString(),
      workerId,
    });
    if (knowledgeProjectionError !== undefined) {
      throw new Error(
        `Knowledge projection failed: ${knowledgeProjectionError}`,
      );
    }
    if (knowledgeLifecycleProjectionError !== undefined) {
      throw new Error(
        "Knowledge lifecycle projection failed: " +
        knowledgeLifecycleProjectionError,
      );
    }
    if (correctionProjectionError !== undefined) {
      throw new Error(
        `Correction projection failed: ${correctionProjectionError}`,
      );
    }
    return result;
  } finally {
    knowledgeBackend?.close();
    store?.close();
    await workerLease.release();
  }
};
