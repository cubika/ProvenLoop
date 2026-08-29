import {
  EvaluationReportInputError,
  regenerateMarkdownReport,
  runEvaluation,
} from "@provenloop/evaluation";

export interface CliIo {
  readonly error: (message: string) => void;
  readonly log: (message: string) => void;
}

const defaultIo: CliIo = {
  error: (message) => console.error(message),
  log: (message) => console.log(message),
};

const option = (
  args: readonly string[],
  name: string,
): string | undefined => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const usage = `Usage:
  provenloop eval run --suite <suite> --out <directory>
  provenloop eval report --run <run-id-or-directory>`;

export const runCli = async (
  args: readonly string[],
  io: CliIo = defaultIo,
): Promise<number> => {
  if (args[0] !== "eval") {
    io.error(usage);
    return 2;
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
