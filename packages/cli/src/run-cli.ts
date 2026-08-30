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
  EvaluationReportInputError,
  loadEpisodeAssociationDataset,
  regenerateMarkdownReport,
  renderEpisodeAssociationReport,
  runEvaluation,
  runM0ReleaseGate,
} from "@provenloop/evaluation";
import {
  resolveWindowsProvenLoopDataRoot,
} from "@provenloop/platform-windows";

import { runMcpServer } from "./run-mcp-server.js";

export interface CliIo {
  readonly error: (message: string) => void;
  readonly log: (message: string) => void;
}

export interface CliDependencies {
  readonly createAdapter: (
    dataRoot: string,
  ) => AgentAdapter;
  readonly runMcpServer: () => Promise<void>;
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
  runMcpServer,
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

export const runCli = async (
  args: readonly string[],
  io: CliIo = defaultIo,
  dependencies: CliDependencies = defaultDependencies,
): Promise<number> => {
  if (args[0] === "eval") {
    return runEvaluationCommand(args, io);
  }
  if (args[0] === "mcp" && args[1] === "serve") {
    try {
      await dependencies.runMcpServer();
      return 0;
    } catch (error) {
      io.error(error instanceof Error ? error.message : String(error));
      return 3;
    }
  }
  if (
    ![
      "disable",
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
