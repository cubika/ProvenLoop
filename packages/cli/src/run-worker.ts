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
import {
  BranchContextProjector,
  CaptureWorker,
  CaptureWorkerCircuitBreaker,
  WorkEpisodeProjector,
  type CaptureWorkerRunResult,
} from "@provenloop/host";
import {
  resolveWindowsCaptureWorkerLeaseName,
  resolveWindowsProvenLoopPaths,
  WindowsCaptureQueue,
  WindowsNamedPipeLeaseProvider,
  type ProcessLeaseProvider,
} from "@provenloop/platform-windows";
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

const writeHeartbeat = async (
  path: string,
  input: {
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
    if (result.status === "completed") {
      new WorkEpisodeProjector({
        store,
      }).rebuild();
      new BranchContextProjector({
        store,
      }).rebuild();
    }
    store.close();
    store = undefined;
    await writeHeartbeat(paths.heartbeat, {
      result,
      timestamp: now().toISOString(),
      workerId,
    });
    return result;
  } finally {
    store?.close();
    await workerLease.release();
  }
};
