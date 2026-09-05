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
  type CaptureWorkerAdmission,
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
  readonly admission?: () =>
    | CaptureWorkerAdmission
    | Promise<CaptureWorkerAdmission>;
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

const KNOWLEDGE_PROJECTION_LEASE_TIMEOUT_MS = 5_000;
const LEASE_RETRY_DELAY_MS = 25;

const acquireRequiredLease = async (
  provider: ProcessLeaseProvider,
): Promise<ProcessLease> => {
  const deadline =
    Date.now() + KNOWLEDGE_PROJECTION_LEASE_TIMEOUT_MS;
  let lease = await provider.tryAcquire();
  while (lease === undefined) {
    if (Date.now() >= deadline) {
      throw new Error(
        "Timed out waiting for the Knowledge projection lease.",
      );
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, LEASE_RETRY_DELAY_MS);
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
    let projectionMarked = await access(
      paths.projectionDirty,
    ).then(
      () => true,
      () => false,
    );
    const markProjectionDirty = async (): Promise<void> => {
      if (projectionMarked) {
        return;
      }
      await writeFile(
        paths.projectionDirty,
        `${JSON.stringify({
          markedAt: now().toISOString(),
          schemaVersion: 1,
        })}\n`,
        "utf8",
      );
      projectionMarked = true;
    };
    const result = await new CaptureWorker({
      admission:
        options.admission ??
        (async () => {
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
        }),
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
      onCanonicalMutationPending: markProjectionDirty,
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
    const projectionRequired =
      result.status === "completed" &&
      (result.stored > 0 || projectionMarked);
    let correctionCaptureIssueCount: number | undefined;
    let correctionCaptureIssues: readonly string[] | undefined;
    let correctionProjectionError: string | undefined;
    let knowledgeLifecycleProjectionError: string | undefined;
    if (projectionRequired) {
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
      projectionRequired &&
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
          try {
            await knowledgeBackend.closeAsync();
            knowledgeBackend = undefined;
          } finally {
            await knowledgeLease.release();
          }
        }
      } catch (error) {
        knowledgeProjectionError = sanitizeDiagnostic(error);
      } finally {
        await knowledgeBackend?.closeAsync();
        knowledgeBackend = undefined;
      }
    }
    if (
      projectionRequired &&
      correctionProjectionError === undefined &&
      knowledgeLifecycleProjectionError === undefined &&
      knowledgeProjectionError === undefined
    ) {
      await unlink(paths.projectionDirty).catch((error: unknown) => {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
        ) {
          throw error;
        }
      });
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
    try {
      await knowledgeBackend?.closeAsync();
    } finally {
      try {
        store?.close();
      } finally {
        await workerLease.release();
      }
    }
  }
};
