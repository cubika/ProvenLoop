import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { join } from "node:path";

import type {
  AdapterOperationResult,
  AgentAdapter,
} from "@provenloop/contracts";
import {
  provenLoopCapabilitySchema,
} from "@provenloop/contracts";
import {
  CopilotCliAdapter,
} from "@provenloop/copilot-adapter";
import {
  evaluateEpisodeAssociationDataset,
  EvidenceLedgerWriter,
  EvaluationReportInputError,
  loadEpisodeAssociationDataset,
  regenerateMarkdownReport,
  renderEpisodeAssociationReport,
  runEvaluation,
  runM0ReleaseGate,
} from "@provenloop/evaluation";
import {
  DeletionPropagationGateError,
  DeletionService,
  type CaptureWorkerRunResult,
} from "@provenloop/host";
import {
  resolveWindowsProvenLoopDataRoot,
  resolveWindowsProvenLoopLeaseName,
  resolveWindowsProvenLoopPaths,
  WindowsCaptureQueue,
  WindowsNamedPipeLeaseProvider,
} from "@provenloop/platform-windows";
import {
  KnowledgeProjectionManager,
  SqliteFtsKnowledgeBackend,
} from "@provenloop/retrieval";
import {
  CanonicalSqliteStore,
} from "@provenloop/storage-sqlite";

import {
  runMcpServer,
  type McpServerOptions,
} from "./run-mcp-server.js";
import {
  runCaptureWorkerOnce,
  type RunCaptureWorkerOnceOptions,
} from "./run-worker.js";

export interface CliIo {
  readonly error: (message: string) => void;
  readonly log: (message: string) => void;
}

export interface CliDependencies {
  readonly createAdapter: (
    dataRoot: string,
  ) => AgentAdapter;
  readonly runMcpServer: (
    options?: McpServerOptions,
  ) => Promise<void>;
  readonly runWorker?: (
    options: RunCaptureWorkerOnceOptions,
  ) => Promise<CaptureWorkerRunResult>;
}

const defaultIo: CliIo = {
  error: (message) => console.error(message),
  log: (message) => console.log(message),
};

const defaultDependencies: CliDependencies = {
  createAdapter: (dataRoot) =>
    new CopilotCliAdapter({
      dataRoot,
    }),
  runMcpServer: (options) =>
    runMcpServer(undefined, options),
  runWorker: runCaptureWorkerOnce,
};

const option = (
  args: readonly string[],
  name: string,
): string | undefined => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const usage = `Usage:
  provenloop install [--data-root <directory>]
  provenloop status [--data-root <directory>]
  provenloop doctor [--data-root <directory>]
  provenloop enable <capability> [--data-root <directory>]
  provenloop disable <capability> [--data-root <directory>]
  provenloop delete (--source <event-or-dedup-id> | --session <id> | --episode <id>) [--data-root <directory>]
  provenloop worker run [--batch-size <count>] [--data-root <directory>]
  provenloop uninstall [--purge] [--data-root <directory>]
  provenloop eval episodes [--dataset <file>]
  provenloop eval m0 --out <directory>
  provenloop eval run --suite <suite> --out <directory>
  provenloop eval report --run <run-id-or-directory>`;

const dataRoot = (args: readonly string[]): string =>
  option(args, "--data-root") ??
  resolveWindowsProvenLoopDataRoot();

const hasInvalidOptionValue = (
  args: readonly string[],
  name: string,
): boolean => {
  const index = args.indexOf(name);
  return index !== -1 && (
    args[index + 1] === undefined ||
    args[index + 1]?.startsWith("--") === true
  );
};

const operationExitCode = (
  result: AdapterOperationResult,
): number => result.status === "incompatible" ? 1 : 0;

const deletionTarget = (
  args: readonly string[],
):
  | {
      readonly targetId: string;
      readonly targetType: "episode" | "session" | "source";
    }
  | undefined => {
  const targets = [
    ["--source", "source"],
    ["--session", "session"],
    ["--episode", "episode"],
  ] as const;
  const selected = targets.flatMap(([
    name,
    targetType,
  ]) => {
    const targetId = option(args, name);
    return args.includes(name) &&
      targetId !== undefined &&
      !targetId.startsWith("--")
      ? [
          {
            targetId,
            targetType,
          },
        ]
      : [];
  });
  return selected.length === 1 ? selected[0] : undefined;
};

const runDeletionCommand = async (
  args: readonly string[],
  io: CliIo,
): Promise<number> => {
  const target = deletionTarget(args);
  if (
    target === undefined ||
    ["--source", "--session", "--episode"].some((name) =>
      hasInvalidOptionValue(args, name),
    ) ||
    hasInvalidOptionValue(args, "--data-root")
  ) {
    io.error(usage);
    return 2;
  }
  const root = dataRoot(args);
  const paths = resolveWindowsProvenLoopPaths(root);
  const deletionId = `deletion-${randomUUID()}`;
  let knowledgeBackend: SqliteFtsKnowledgeBackend | undefined;
  let store: CanonicalSqliteStore | undefined;
  try {
    await access(paths.rootMarker);
    await access(paths.database);
    const queue = new WindowsCaptureQueue(paths.queue);
    await queue.initialize();
    store = new CanonicalSqliteStore(paths.database);
    knowledgeBackend = new SqliteFtsKnowledgeBackend(
      paths.knowledgeDatabase,
    );
    const knowledgeProjection = new KnowledgeProjectionManager({
      backend: knowledgeBackend,
      store,
    });
    const ledgers = new Map<string, EvidenceLedgerWriter>();
    const result = await new DeletionService({
      knowledgeProjection: {
        acquireLease: async () => {
          const leaseName = await resolveWindowsProvenLoopLeaseName(
            paths.root,
            "knowledge-projection",
          );
          const provider = new WindowsNamedPipeLeaseProvider(
            leaseName,
          );
          let lease = await provider.tryAcquire();
          while (lease === undefined) {
            await new Promise<void>((resolve) => {
              setTimeout(resolve, 5);
            });
            lease = await provider.tryAcquire();
          }
          return lease;
        },
        rebuild: async () => {
          await knowledgeProjection.rebuild();
        },
        remainingIdentifiers: async (identifiers) => {
          const remaining: string[] = [];
          for (const identifier of identifiers) {
            if (!identifier.startsWith("knowledge:")) {
              continue;
            }
            const backendIdentifier = identifier.slice(
              "knowledge:".length,
            );
            if (
              await knowledgeBackend?.get(backendIdentifier) !== undefined
            ) {
              remaining.push(identifier);
            }
          }
          return remaining;
        },
      },
      queue,
      recordEvidence: async (entry) => {
        let ledger = ledgers.get(entry.runId);
        if (ledger === undefined) {
          ledger = new EvidenceLedgerWriter(
            join(
              paths.evaluation,
              "deletions",
              entry.runId,
              "evidence-ledger.jsonl",
            ),
          );
          await ledger.initialize();
          ledgers.set(entry.runId, ledger);
        }
        await ledger.appendIfAbsent([
          entry,
        ]);
      },
      store,
    }).delete({
      deletionId,
      ...target,
    });
    io.log(
      `Deletion completed: ${result.operation.deletedSourceCount} source identifiers, ` +
      `${result.operation.deletedDependentCount} dependent records, ` +
      `${result.operation.deletedQueueItemCount} queue items.`,
    );
    return 0;
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return error instanceof DeletionPropagationGateError ? 1 : 3;
  } finally {
    knowledgeBackend?.close();
    store?.close();
  }
};

const runEvaluationCommand = async (
  args: readonly string[],
  io: CliIo,
): Promise<number> => {
  if (args[1] === "m0") {
    const outputRoot = option(args, "--out");
    if (!outputRoot || outputRoot.startsWith("--")) {
      io.error(usage);
      return 2;
    }
    try {
      const result = await runM0ReleaseGate({
        outputRoot,
      });
      io.log(
        `M0 release gate ${result.report.status}: ${result.runDirectory}`,
      );
      return result.report.exitCode;
    } catch (error) {
      io.error(error instanceof Error ? error.message : String(error));
      return 3;
    }
  }
  if (args[1] === "episodes") {
    if (hasInvalidOptionValue(args, "--dataset")) {
      io.error(usage);
      return 2;
    }
    try {
      const datasetPath = option(args, "--dataset");
      const report = evaluateEpisodeAssociationDataset(
        await loadEpisodeAssociationDataset(datasetPath),
      );
      io.log(renderEpisodeAssociationReport(report));
      return report.status === "pass" ? 0 : 1;
    } catch (error) {
      io.error(error instanceof Error ? error.message : String(error));
      return 2;
    }
  }
  if (args[1] === "run") {
    const suite = option(args, "--suite");
    const outputRoot = option(args, "--out");
    if (!suite || !outputRoot) {
      io.error(usage);
      return 2;
    }

    try {
      const result = await runEvaluation({
        outputRoot,
        suite,
      });
      io.log(
        `Evaluation ${result.report.status}: ${result.runDirectory}`,
      );
      return result.report.exitCode;
    } catch (error) {
      io.error(error instanceof Error ? error.message : String(error));
      return 3;
    }
  }

  if (args[1] === "report") {
    const run = option(args, "--run");
    if (!run) {
      io.error(usage);
      return 2;
    }

    try {
      const result = await regenerateMarkdownReport(run);
      io.log(result.markdown);
      return result.report.exitCode;
    } catch (error) {
      io.error(error instanceof Error ? error.message : String(error));
      return error instanceof EvaluationReportInputError ? 2 : 3;
    }
  }

  io.error(usage);
  return 2;
};

const runWorkerCommand = async (
  args: readonly string[],
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> => {
  const rawBatchSize = option(args, "--batch-size");
  const batchSize =
    rawBatchSize === undefined ? 100 : Number(rawBatchSize);
  if (
    args[1] !== "run" ||
    hasInvalidOptionValue(args, "--batch-size") ||
    hasInvalidOptionValue(args, "--data-root") ||
    !Number.isInteger(batchSize) ||
    batchSize <= 0
  ) {
    io.error(usage);
    return 2;
  }
  try {
    const result = await (
      dependencies.runWorker ?? runCaptureWorkerOnce
    )({
      batchSize,
      dataRoot: dataRoot(args),
    });
    io.log(JSON.stringify(result, null, 2));
    return result.status === "circuit_open" ||
      (
        result.status === "completed" &&
        (
          result.failed > 0 ||
          result.circuitOpenReasons.length > 0
        )
      )
      ? 1
      : 0;
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return 3;
  }
};

export const runCli = async (
  args: readonly string[],
  io: CliIo = defaultIo,
  dependencies: CliDependencies = defaultDependencies,
): Promise<number> => {
  if (args[0] === "eval") {
    return runEvaluationCommand(args, io);
  }
  if (args[0] === "delete") {
    return runDeletionCommand(args, io);
  }
  if (args[0] === "worker") {
    return runWorkerCommand(args, io, dependencies);
  }
  if (args[0] === "mcp" && args[1] === "serve") {
    if (hasInvalidOptionValue(args, "--data-root")) {
      io.error(usage);
      return 2;
    }
    try {
      await dependencies.runMcpServer({
        dataRoot: dataRoot(args),
      });
      return 0;
    } catch (error) {
      io.error(error instanceof Error ? error.message : String(error));
      return 3;
    }
  }
  if (
    ![
      "disable",
      "delete",
      "doctor",
      "enable",
      "install",
      "status",
      "uninstall",
    ].includes(args[0] ?? "")
  ) {
    io.error(usage);
    return 2;
  }
  if (hasInvalidOptionValue(args, "--data-root")) {
    io.error(usage);
    return 2;
  }

  try {
    const adapter = dependencies.createAdapter(dataRoot(args));
    switch (args[0]) {
      case "install": {
        const result = await adapter.install();
        io.log(result.message);
        return operationExitCode(result);
      }
      case "status":
        io.log(JSON.stringify(await adapter.status(), null, 2));
        return 0;
      case "doctor": {
        const health = await adapter.doctor();
        io.log(JSON.stringify(health, null, 2));
        return health.status === "healthy"
          ? 0
          : health.status === "degraded"
            ? 1
            : 3;
      }
      case "enable":
      case "disable": {
        const capability = provenLoopCapabilitySchema.safeParse(
          args[1],
        );
        if (!capability.success) {
          io.error(usage);
          return 2;
        }
        const result =
          args[0] === "enable"
            ? await adapter.enable(capability.data)
            : await adapter.disable(capability.data);
        io.log(result.message);
        return operationExitCode(result);
      }
      case "uninstall": {
        const result = await adapter.uninstall({
          purge: args.includes("--purge"),
        });
        io.log(result.message);
        return operationExitCode(result);
      }
    }
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return 3;
  }
  io.error(usage);
  return 2;
};
