import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  AdapterOperationResult,
  AgentAdapter,
  Scope,
} from "@provenloop/contracts";
import {
  provenLoopCapabilitySchema,
  scopeSchema,
} from "@provenloop/contracts";
import {
  CopilotCliAdapter,
} from "@provenloop/copilot-adapter";
import {
  evaluateEpisodeAssociationDataset,
  EvidenceLedgerWriter,
  EvaluationReportInputError,
  loadEpisodeAssociationDataset,
  M0AcceptanceEvidenceInputError,
  regenerateMarkdownReport,
  renderEpisodeAssociationReport,
  runEvaluation,
  runM0ReleaseGate,
  runM1ReleaseGate,
  runM2ReleaseGate,
  runMvpReleaseGate,
  MvpReleaseInputError,
} from "@provenloop/evaluation";
import {
  DeletionPropagationGateError,
  DeletionService,
  KnowledgeControlService,
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
  branchScopeIdFor,
  KnowledgeProjectionManager,
  SqliteFtsKnowledgeBackend,
} from "@provenloop/retrieval";
import {
  CanonicalSqliteStore,
} from "@provenloop/storage-sqlite";

import {
  completeM0DailyAcceptance,
  startM0DailyAcceptance,
} from "./m0-daily-acceptance.js";
import {
  runMcpServer,
  type McpServerOptions,
} from "./run-mcp-server.js";
import {
  runCaptureWorkerOnce,
  type RunCaptureWorkerOnceOptions,
} from "./run-worker.js";
import {
  PROVENLOOP_CODE_VERSION,
  releaseMetadata,
} from "./release-metadata.js";

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
      cliBinPath: fileURLToPath(
        new URL("./bin.js", import.meta.url),
      ),
      dataRoot,
      extensionModuleUrl:
        new URL("./extension-entry.js", import.meta.url).href,
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
  provenloop install [--no-auto-collect] [--data-root <directory>]
  provenloop version
  provenloop runtime extension-path
  provenloop upgrade [--data-root <directory>]
  provenloop status [--data-root <directory>]
  provenloop doctor [--online] [--data-root <directory>]
  provenloop enable <capability> [--data-root <directory>]
  provenloop disable <capability> [--data-root <directory>]
  provenloop collection <enable|disable> [--data-root <directory>]
  provenloop remember --content <text> --when <condition> [--not-when <condition>] [--scope <personal|workflow|repository|branch>] [--workflow <id>] [--cwd <directory>] [--data-root <directory>]
  provenloop correct <knowledge-id> [--reason <text>] [--data-root <directory>]
  provenloop mute <knowledge-id> --session <id> [--data-root <directory>]
  provenloop forget <knowledge-or-playbook> [--data-root <directory>]
  provenloop delete (--source <event-or-dedup-id> | --session <id> | --episode <id> | --knowledge <id>) [--data-root <directory>]
  provenloop worker run [--batch-size <count>] [--data-root <directory>]
  provenloop uninstall [--purge] [--data-root <directory>]
  provenloop purge [--data-root <directory>]
  provenloop acceptance start [--session-root <directory>] [--data-root <directory>]
  provenloop acceptance complete [--drain-timeout <seconds>] [--data-root <directory>]
  provenloop eval episodes [--dataset <file>]
  provenloop eval m0 --out <directory> [--evidence <file>]
  provenloop eval m1 --out <directory> [--dataset <file>] [--stable]
  provenloop eval m2 --out <directory> [--dataset <file>] [--stable]
  provenloop eval mvp --out <directory> [--evidence <file>] [--stable]
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

const hasOnlyOptions = (
  args: readonly string[],
  startIndex: number,
  input: {
    readonly flags?: readonly string[];
    readonly values?: readonly string[];
  },
): boolean => {
  const flags = new Set(input.flags ?? []);
  const values = new Set(input.values ?? []);
  const seen = new Set<string>();
  let index = startIndex;
  while (index < args.length) {
    const argument = args[index];
    if (
      argument === undefined ||
      seen.has(argument)
    ) {
      return false;
    }
    if (flags.has(argument)) {
      seen.add(argument);
      index += 1;
      continue;
    }
    if (!values.has(argument)) {
      return false;
    }
    const value = args[index + 1];
    if (
      value === undefined ||
      value.startsWith("--")
    ) {
      return false;
    }
    seen.add(argument);
    index += 2;
  }
  return true;
};

const operationExitCode = (
  result: AdapterOperationResult,
): number => result.status === "incompatible" ? 1 : 0;

const acquireKnowledgeProjectionLease = async (
  root: string,
) => {
  const leaseName = await resolveWindowsProvenLoopLeaseName(
    root,
    "knowledge-projection",
  );
  const provider = new WindowsNamedPipeLeaseProvider(leaseName);
  let lease = await provider.tryAcquire();
  while (lease === undefined) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
    lease = await provider.tryAcquire();
  }
  return lease;
};

const withKnowledgeControl = async <T>(
  root: string,
  operation: (
    service: KnowledgeControlService,
  ) => Promise<T> | T,
): Promise<T> => {
  const paths = resolveWindowsProvenLoopPaths(root);
  await access(paths.rootMarker);
  await access(paths.database);
  const outerLease = await acquireKnowledgeProjectionLease(
    paths.root,
  );
  let store: CanonicalSqliteStore | undefined;
  let backend: SqliteFtsKnowledgeBackend | undefined;
  try {
    store = new CanonicalSqliteStore(paths.database);
    backend = new SqliteFtsKnowledgeBackend(
      paths.knowledgeDatabase,
    );
    const projection = new KnowledgeProjectionManager({
      backend,
      store,
    });
    return await operation(
      new KnowledgeControlService({
        projection: {
          acquireLease: async () => ({
            release: async () => undefined,
          }),
          rebuild: () => projection.rebuild().then(() => undefined),
        },
        store,
      }),
    );
  } finally {
    await backend?.closeAsync();
    store?.close();
    await outerLease.release();
  }
};

const rememberScopeId = async (
  scope: Scope,
  args: readonly string[],
  adapter: AgentAdapter,
): Promise<string | undefined> => {
  if (scope === "personal") {
    return undefined;
  }
  if (scope === "workflow") {
    const workflow = option(args, "--workflow")?.trim();
    if (!workflow) {
      throw new Error(
        "Workflow-scoped Knowledge requires --workflow.",
      );
    }
    return workflow;
  }
  const identity = await adapter.resolveSession({
    adapterVersion: "user-control",
    cwd: option(args, "--cwd") ?? process.cwd(),
    sessionId: `control-${randomUUID()}`,
  });
  if (identity.repositoryId === undefined) {
    throw new Error(
      "Repository identity is unavailable for remember.",
    );
  }
  if (scope === "repository") {
    return identity.repositoryId;
  }
  if (identity.branch === undefined) {
    throw new Error(
      "Branch identity is unavailable for remember.",
    );
  }
  return branchScopeIdFor(
    identity.repositoryId,
    identity.branch,
  );
};

const runKnowledgeControlCommand = async (
  args: readonly string[],
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> => {
  const shapeIsValid =
    args[0] === "remember"
      ? hasOnlyOptions(args, 1, {
          values: [
            "--content",
            "--cwd",
            "--data-root",
            "--not-when",
            "--scope",
            "--when",
            "--workflow",
          ],
        })
      : args[0] === "correct"
        ? hasOnlyOptions(args, 2, {
            values: [
              "--data-root",
              "--reason",
            ],
          })
        : args[0] === "mute"
          ? hasOnlyOptions(args, 2, {
              values: [
                "--data-root",
                "--session",
              ],
            })
          : args[0] === "forget"
            ? hasOnlyOptions(args, 2, {
                values: [
                  "--data-root",
                ],
              })
            : false;
  if (
    !shapeIsValid ||
    hasInvalidOptionValue(args, "--data-root") ||
    hasInvalidOptionValue(args, "--content") ||
    hasInvalidOptionValue(args, "--when") ||
    hasInvalidOptionValue(args, "--not-when") ||
    hasInvalidOptionValue(args, "--scope") ||
    hasInvalidOptionValue(args, "--workflow") ||
    hasInvalidOptionValue(args, "--cwd") ||
    hasInvalidOptionValue(args, "--reason") ||
    hasInvalidOptionValue(args, "--session")
  ) {
    io.error(usage);
    return 2;
  }
  const root = dataRoot(args);
  try {
    switch (args[0]) {
      case "remember": {
        const content = option(args, "--content");
        const appliesWhen = option(args, "--when");
        const scopeResult = scopeSchema.safeParse(
          option(args, "--scope") ?? "repository",
        );
        if (
          !content ||
          !appliesWhen ||
          !scopeResult.success
        ) {
          io.error(usage);
          return 2;
        }
        const adapter = dependencies.createAdapter(root);
        const scopeId = await rememberScopeId(
          scopeResult.data,
          args,
          adapter,
        );
        const result = await withKnowledgeControl(
          root,
          (service) =>
            service.remember({
              appliesWhen: [
                appliesWhen,
              ],
              content,
              nonApplicability: [
                ...(option(args, "--not-when") === undefined
                  ? []
                  : [
                      option(args, "--not-when") ?? "",
                    ]),
              ],
              scope: scopeResult.data,
              ...(scopeId === undefined ? {} : { scopeId }),
            }),
        );
        io.log(
          result.changed
            ? `Remembered Knowledge ${result.candidate?.knowledgeId}.`
            : `Knowledge ${result.candidate?.knowledgeId} was already remembered.`,
        );
        return 0;
      }
      case "correct": {
        const knowledgeId = args[1]?.trim();
        const reason = option(args, "--reason");
        if (!knowledgeId || knowledgeId.startsWith("--")) {
          io.error(usage);
          return 2;
        }
        const result = await withKnowledgeControl(
          root,
          (service) =>
            service.correct({
              knowledgeId,
              ...(reason === undefined
                ? {}
                : {
                    reason,
                  }),
            }),
        );
        io.log(
          result.changed
            ? `Knowledge ${knowledgeId} marked disputed.`
            : `Knowledge ${knowledgeId} was already corrected.`,
        );
        return 0;
      }
      case "mute": {
        const knowledgeId = args[1]?.trim();
        const sessionId = option(args, "--session");
        if (
          !knowledgeId ||
          knowledgeId.startsWith("--") ||
          !sessionId
        ) {
          io.error(usage);
          return 2;
        }
        const result = await withKnowledgeControl(
          root,
          (service) =>
            service.mute({
              knowledgeId,
              sessionId,
            }),
        );
        io.log(
          result.changed
            ? `Knowledge ${knowledgeId} muted for Session ${sessionId}.`
            : `Knowledge ${knowledgeId} is already muted for that Session.`,
        );
        return 0;
      }
      case "forget": {
        const targetId = args[1]?.trim();
        if (!targetId || targetId.startsWith("--")) {
          io.error(usage);
          return 2;
        }
        return runDeletionCommand(
          [
            "delete",
            "--knowledge",
            targetId,
            "--data-root",
            root,
          ],
          io,
        );
      }
    }
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return 3;
  }
  io.error(usage);
  return 2;
};

const deletionTarget = (
  args: readonly string[],
):
  | {
      readonly targetId: string;
      readonly targetType:
        | "episode"
        | "knowledge"
        | "session"
        | "source";
    }
  | undefined => {
  const targets = [
    ["--source", "source"],
    ["--session", "session"],
    ["--episode", "episode"],
    ["--knowledge", "knowledge"],
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
    !hasOnlyOptions(args, 1, {
      values: [
        "--data-root",
        "--episode",
        "--knowledge",
        "--session",
        "--source",
      ],
    }) ||
    [
      "--source",
      "--session",
      "--episode",
      "--knowledge",
    ].some((name) =>
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
  let projectionLease: Awaited<
    ReturnType<typeof acquireKnowledgeProjectionLease>
  > | undefined;
  try {
    await access(paths.rootMarker);
    await access(paths.database);
    projectionLease = await acquireKnowledgeProjectionLease(
      paths.root,
    );
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
        acquireLease: async () => ({
          release: async () => undefined,
        }),
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
      `${
        target.targetType === "knowledge"
          ? "Forget"
          : "Deletion"
      } completed: ${result.operation.deletedSourceCount} source identifiers, ` +
      `${result.operation.deletedDependentCount} dependent records, ` +
      `${result.operation.deletedQueueItemCount} queue items.`,
    );
    return 0;
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return error instanceof DeletionPropagationGateError ? 1 : 3;
  } finally {
    try {
      await knowledgeBackend?.closeAsync();
    } finally {
      try {
        store?.close();
      } finally {
        await projectionLease?.release();
      }
    }
  }
};

const runEvaluationCommand = async (
  args: readonly string[],
  io: CliIo,
): Promise<number> => {
  if (args[1] === "m0") {
    const outputRoot = option(args, "--out");
    const evidencePath = option(args, "--evidence");
    if (
      !outputRoot ||
      outputRoot.startsWith("--") ||
      hasInvalidOptionValue(args, "--evidence")
    ) {
      io.error(usage);
      return 2;
    }
    try {
      const result = await runM0ReleaseGate({
        ...(evidencePath === undefined
          ? {}
          : {
              evidencePath,
            }),
        outputRoot,
        codeVersion: PROVENLOOP_CODE_VERSION,
      });
      io.log(
        `M0 release gate ${result.report.status}: ${result.runDirectory}`,
      );
      return result.report.exitCode;
    } catch (error) {
      io.error(error instanceof Error ? error.message : String(error));
      return error instanceof M0AcceptanceEvidenceInputError
        ? 2
        : 3;
    }
  }
  if (args[1] === "m1") {
    const outputRoot = option(args, "--out");
    const datasetPath = option(args, "--dataset");
    if (
      !outputRoot ||
      outputRoot.startsWith("--") ||
      hasInvalidOptionValue(args, "--dataset")
    ) {
      io.error(usage);
      return 2;
    }
    try {
      const result = await runM1ReleaseGate({
        ...(datasetPath === undefined
          ? {}
          : {
              datasetPath,
            }),
        outputRoot,
        releaseTarget: args.includes("--stable")
          ? "stable"
          : "research",
      });
      io.log(
        `M1 release gate ${result.report.status}: ${result.runDirectory}`,
      );
      return result.report.exitCode;
    } catch (error) {
      io.error(error instanceof Error ? error.message : String(error));
      return 3;
    }
  }
  if (args[1] === "m2") {
    const outputRoot = option(args, "--out");
    const datasetPath = option(args, "--dataset");
    if (
      !hasOnlyOptions(args, 2, {
        flags: [
          "--stable",
        ],
        values: [
          "--dataset",
          "--out",
        ],
      }) ||
      !outputRoot ||
      outputRoot.startsWith("--") ||
      hasInvalidOptionValue(args, "--dataset")
    ) {
      io.error(usage);
      return 2;
    }
    try {
      const result = await runM2ReleaseGate({
        ...(datasetPath === undefined
          ? {}
          : {
              datasetPath,
            }),
        outputRoot,
        releaseTarget: args.includes("--stable")
          ? "stable"
          : "research",
      });
      io.log(
        `M2 release gate ${result.report.status}: ${result.runDirectory}`,
      );
      return result.report.exitCode;
    } catch (error) {
      io.error(error instanceof Error ? error.message : String(error));
      return 3;
    }
  }
  if (args[1] === "mvp") {
    const outputRoot = option(args, "--out");
    const evidencePath = option(args, "--evidence");
    if (
      !hasOnlyOptions(args, 2, {
        flags: [
          "--stable",
        ],
        values: [
          "--evidence",
          "--out",
        ],
      }) ||
      !outputRoot ||
      outputRoot.startsWith("--") ||
      hasInvalidOptionValue(args, "--evidence")
    ) {
      io.error(usage);
      return 2;
    }
    try {
      const result = await runMvpReleaseGate({
        ...(evidencePath === undefined
          ? {}
          : {
              evidencePath,
            }),
        outputRoot,
        codeVersion: PROVENLOOP_CODE_VERSION,
        releaseTarget: args.includes("--stable")
          ? "stable"
          : "research",
      });
      io.log(
        `MVP release decision ${result.report.decision}: ${result.runDirectory}`,
      );
      return result.report.exitCode;
    } catch (error) {
      io.error(error instanceof Error ? error.message : String(error));
      return error instanceof MvpReleaseInputError ? 2 : 3;
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

const runAcceptanceCommand = async (
  args: readonly string[],
  io: CliIo,
): Promise<number> => {
  if (args[1] === "start") {
    if (
      hasInvalidOptionValue(args, "--session-root") ||
      hasInvalidOptionValue(args, "--data-root") ||
      !hasOnlyOptions(args, 2, {
        values: [
          "--data-root",
          "--session-root",
        ],
      })
    ) {
      io.error(usage);
      return 2;
    }
    try {
      const sessionRoot = option(args, "--session-root");
      const result = await startM0DailyAcceptance({
        dataRoot: dataRoot(args),
        ...(sessionRoot === undefined
          ? {}
          : {
              sessionRoot,
            }),
      });
      io.log(
        `M0 daily acceptance started: ${result.runDirectory}`,
      );
      return 0;
    } catch (error) {
      io.error(error instanceof Error ? error.message : String(error));
      return 3;
    }
  }
  if (args[1] === "complete") {
    const rawTimeout = option(args, "--drain-timeout");
    const timeoutSeconds =
      rawTimeout === undefined ? 30 : Number(rawTimeout);
    if (
      hasInvalidOptionValue(args, "--drain-timeout") ||
      hasInvalidOptionValue(args, "--data-root") ||
      !Number.isFinite(timeoutSeconds) ||
      timeoutSeconds <= 0 ||
      !hasOnlyOptions(args, 2, {
        values: [
          "--data-root",
          "--drain-timeout",
        ],
      })
    ) {
      io.error(usage);
      return 2;
    }
    try {
      const result = await completeM0DailyAcceptance({
        dataRoot: dataRoot(args),
        drainTimeoutMs: timeoutSeconds * 1_000,
      });
      io.log(
        `M0 daily acceptance ${result.status}: ${result.runDirectory}`,
      );
      return result.status === "fail" ? 1 : 0;
    } catch (error) {
      io.error(error instanceof Error ? error.message : String(error));
      return 3;
    }
  }
  io.error(usage);
  return 2;
};

const runCollectionCommand = async (
  args: readonly string[],
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> => {
  if (
    ![
      "disable",
      "enable",
    ].includes(args[1] ?? "") ||
    hasInvalidOptionValue(args, "--data-root") ||
    !hasOnlyOptions(args, 2, {
      values: [
        "--data-root",
      ],
    })
  ) {
    io.error(usage);
    return 2;
  }
  try {
    const adapter = dependencies.createAdapter(dataRoot(args));
    const operation = args[1] === "enable"
      ? adapter.enable.bind(adapter)
      : adapter.disable.bind(adapter);
    for (const capability of [
      "capture",
      "worker",
    ] as const) {
      const result = await operation(capability);
      if (result.status === "incompatible") {
        io.error(result.message);
        return 1;
      }
    }
    io.log(
      args[1] === "enable"
        ? "Automatic collection enabled."
        : "Automatic collection disabled.",
    );
    return 0;
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
  if (args[0] === "version" && args.length === 1) {
    io.log(JSON.stringify(releaseMetadata, null, 2));
    return 0;
  }
  if (
    args[0] === "runtime" &&
    args[1] === "extension-path" &&
    args.length === 2
  ) {
    io.log(
      fileURLToPath(new URL("./extension-entry.js", import.meta.url)),
    );
    return 0;
  }
  if (args[0] === "eval") {
    return runEvaluationCommand(args, io);
  }
  if (args[0] === "acceptance") {
    return runAcceptanceCommand(args, io);
  }
  if (args[0] === "collection") {
    return runCollectionCommand(args, io, dependencies);
  }
  if (args[0] === "delete") {
    return runDeletionCommand(args, io);
  }
  if (
    [
      "correct",
      "forget",
      "mute",
      "remember",
    ].includes(args[0] ?? "")
  ) {
    return runKnowledgeControlCommand(
      args,
      io,
      dependencies,
    );
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
    args[0] === "purge" &&
    !hasOnlyOptions(args, 1, {
      values: [
        "--data-root",
      ],
    })
  ) {
    io.error(usage);
    return 2;
  }
  if (
    args[0] === "install" &&
    !hasOnlyOptions(args, 1, {
      flags: [
        "--no-auto-collect",
      ],
      values: [
        "--data-root",
      ],
    })
  ) {
    io.error(usage);
    return 2;
  }
  if (
    args[0] === "doctor" &&
    !hasOnlyOptions(args, 1, {
      flags: [
        "--online",
      ],
      values: [
        "--data-root",
      ],
    })
  ) {
    io.error(usage);
    return 2;
  }
  if (
    args[0] === "uninstall" &&
    !hasOnlyOptions(args, 1, {
      flags: [
        "--purge",
      ],
      values: [
        "--data-root",
      ],
    })
  ) {
    io.error(usage);
    return 2;
  }
  if (
    ![
      "disable",
      "delete",
      "doctor",
      "enable",
      "install",
      "purge",
      "status",
      "uninstall",
      "upgrade",
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
        const result = await adapter.install(
          args.includes("--no-auto-collect")
            ? {
                autoCollect: false,
              }
            : undefined,
        );
        io.log(result.message);
        return operationExitCode(result);
      }
      case "upgrade": {
        const result = await adapter.upgrade();
        io.log(result.message);
        return operationExitCode(result);
      }
      case "status":
        io.log(JSON.stringify(await adapter.status(), null, 2));
        return 0;
      case "doctor": {
        const health = await adapter.doctor({
          online: args.includes("--online"),
        });
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
      case "purge": {
        const result = await adapter.uninstall({
          purge: true,
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
