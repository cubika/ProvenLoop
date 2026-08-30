import { spawn } from "node:child_process";

export interface CommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export interface CommandRunOptions {
  readonly cwd?: string;
  readonly environment?: Readonly<
    Record<string, string | undefined>
  >;
}

export interface CommandRunner {
  run(
    executable: string,
    args: readonly string[],
    options?: CommandRunOptions,
  ): Promise<CommandResult>;
}

const MAX_OUTPUT_CHARACTERS = 1024 * 1024;

const appendBounded = (
  current: string,
  chunk: Buffer | string,
): string =>
  `${current}${String(chunk)}`.slice(0, MAX_OUTPUT_CHARACTERS);

export class SpawnCommandRunner implements CommandRunner {
  public run(
    executable: string,
    args: readonly string[],
    options: CommandRunOptions = {},
  ): Promise<CommandResult> {
    return new Promise((resolve) => {
      let stderr = "";
      let stdout = "";
      const child = spawn(executable, args, {
        cwd: options.cwd,
        env: {
          ...process.env,
          ...options.environment,
        },
        shell: false,
        windowsHide: true,
      });
      child.stdout.on("data", (chunk: Buffer | string) => {
        stdout = appendBounded(stdout, chunk);
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        stderr = appendBounded(stderr, chunk);
      });
      child.once("error", (error) => {
        resolve({
          exitCode: 127,
          stderr: error.message,
          stdout,
        });
      });
      child.once("close", (exitCode) => {
        resolve({
          exitCode: exitCode ?? 1,
          stderr,
          stdout,
        });
      });
    });
  }
}
