import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  join,
  resolve,
} from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CopilotCliAdapter,
  registerInternalCopilotSession,
  runInstalledCopilotExtension,
  type CommandRunOptions,
  type CommandResult,
  type CommandRunner,
} from "@provenloop/copilot-adapter";
import {
  beginExtensionShutdown,
  isExtensionShutdownRequested,
  resolveWindowsCaptureWorkerLeaseName,
  resolveWindowsProvenLoopLeaseName,
  registerActiveExtension,
  waitForActiveExtensionsToStop,
  WindowsNamedPipeLeaseProvider,
} from "@provenloop/platform-windows";

const temporaryDirectories: string[] = [];

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(
    join(tmpdir(), "provenloop-operational-adapter-"),
  );
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        force: true,
        recursive: true,
      }),
    ),
  );
});

class FakeCommandRunner implements CommandRunner {
  public readonly calls: string[] = [];
  public readonly options: {
    readonly command: string;
    readonly timeoutMs: number | undefined;
  }[] = [];
  public readonly failures = new Map<string, CommandResult>();
  public marketplaceRegistered = false;
  public marketplaceSource: string | undefined;
  public pluginEnabled = false;
  public pluginInstalled = false;
  public pluginVersion = "0.1.0-alpha.0.6";
  public providerResult: CommandResult = {
    exitCode: 0,
    stderr: "",
    stdout: "PROVENLOOP_OK\n",
  };
  public registrationProbeFailure = false;
  public unsupportedHelpCommand: string | undefined;
  public version: string | undefined = "1.0.82-0";
  public gitRoot = "C:\\repo\\worktree";

  public run(
    executable: string,
    args: readonly string[],
    options?: CommandRunOptions,
  ): Promise<CommandResult> {
    const command = `${executable} ${args.join(" ")}`;
    this.calls.push(command);
    this.options.push({
      command,
      timeoutMs: options?.timeoutMs,
    });
    const failure = this.failures.get(command);
    if (failure !== undefined) {
      this.failures.delete(command);
      return Promise.resolve(failure);
    }
    if (executable === "git") {
      return Promise.resolve(this.#git(args));
    }
    if (args.length === 1 && args[0] === "--version") {
      return Promise.resolve(
        this.version === undefined
          ?           {
            exitCode: 127,
            stderr: "copilot was not found",
            stdout: "",
          }
          : {
              exitCode: 0,
              stderr: "",
              stdout: `GitHub Copilot CLI ${this.version}.\n`,
            },
      );
    }
    if (args.at(-1) === "--help") {
      return Promise.resolve(
        command === this.unsupportedHelpCommand
          ? {
              exitCode: 1,
              stderr: "Unknown command.",
              stdout: "",
            }
          : this.#success(),
      );
    }
    if (args[0] === "--prompt") {
      return Promise.resolve(this.providerResult);
    }
    if (
      args.join(" ") === "plugin marketplace list"
    ) {
      if (this.registrationProbeFailure) {
        return Promise.resolve({
          exitCode: 1,
          stderr: "Copilot is temporarily unavailable.",
          stdout: "",
        });
      }
      return Promise.resolve({
        exitCode: 0,
        stderr: "",
        stdout: this.marketplaceRegistered
          ? "Registered marketplaces:\n  • provenloop-marketplace " +
            `(GitHub: ${this.marketplaceSource ?? "unknown"})\n`
          : "Registered marketplaces:\n",
      });
    }
    if (args.join(" ") === "plugin list") {
      if (this.registrationProbeFailure) {
        return Promise.resolve({
          exitCode: 1,
          stderr: "Copilot is temporarily unavailable.",
          stdout: "",
        });
      }
      return Promise.resolve({
        exitCode: 0,
        stderr: "",
        stdout: this.pluginInstalled
          ? `Live Plugins:\n  • provenloop@provenloop-marketplace (v${this.pluginVersion}) (${
              this.pluginEnabled ? "enabled" : "disabled"
            })\n`
          : "Live Plugins:\n",
      });
    }
    if (
      args[0] === "plugin" &&
      args[1] === "marketplace" &&
      args[2] === "add"
    ) {
      this.marketplaceRegistered = true;
      this.marketplaceSource = args[3];
      return Promise.resolve(this.#success());
    }
    if (
      args.join(" ") ===
      "plugin marketplace remove provenloop-marketplace"
    ) {
      this.marketplaceRegistered = false;
      this.marketplaceSource = undefined;
      this.pluginEnabled = false;
      this.pluginInstalled = false;
      return Promise.resolve(this.#success());
    }
    if (
      args.join(" ") ===
      "plugin install provenloop@provenloop-marketplace"
    ) {
      this.pluginInstalled = true;
      this.pluginEnabled = true;
      return Promise.resolve(this.#success());
    }
    if (
      args.join(" ") ===
      "plugin uninstall provenloop@provenloop-marketplace"
    ) {
      this.pluginEnabled = false;
      this.pluginInstalled = false;
      return Promise.resolve(this.#success());
    }
    if (
      args.join(" ") ===
        "plugin marketplace update provenloop-marketplace" ||
      args.join(" ") ===
        "plugin update provenloop@provenloop-marketplace"
    ) {
      return Promise.resolve(this.#success());
    }
    if (
      args.join(" ") ===
      "plugins enable provenloop@provenloop-marketplace --plugin"
    ) {
      this.pluginEnabled = true;
      return Promise.resolve(this.#success());
    }
    if (
      args.join(" ") ===
      "plugins disable provenloop@provenloop-marketplace --plugin"
    ) {
      this.pluginEnabled = false;
      return Promise.resolve(this.#success());
    }
    return Promise.resolve({
      exitCode: 1,
      stderr: `Unexpected command: ${command}`,
      stdout: "",
    });
  }

  #success(): CommandResult {
    return {
      exitCode: 0,
      stderr: "",
      stdout: "",
    };
  }

  #git(args: readonly string[]): CommandResult {
    const operation = args.slice(2).join(" ");
    const values: Readonly<Record<string, string>> = {
      "branch --show-current": "feat/batch5-operational-cli-adapter\n",
      "config --get remote.origin.url":
        "https://example.test/ProvenLoop.git\n",
      "rev-parse --git-common-dir": ".git\n",
      "rev-parse --show-toplevel": `${this.gitRoot}\n`,
      "rev-list --parents -n 1 HEAD":
        "ac758f82454bc729604dbf533d9e3b08460385de 0123456789abcdef0123456789abcdef01234567\n",
    };
    const stdout = values[operation];
    return stdout === undefined
      ? {
          exitCode: 1,
          stderr: "not a git repository",
          stdout: "",
        }
      : {
          exitCode: 0,
          stderr: "",
          stdout,
        };
  }
}

class BlockingVersionCommandRunner extends FakeCommandRunner {
  #releaseVersionCheck: (() => void) | undefined;
  #reportVersionCheckStarted: (() => void) | undefined;
  readonly #versionCheckGate: Promise<void>;
  public readonly versionCheckStarted: Promise<void>;

  public constructor() {
    super();
    this.versionCheckStarted = new Promise<void>((resolve) => {
      this.#reportVersionCheckStarted = resolve;
    });
    this.#versionCheckGate = new Promise<void>((resolve) => {
      this.#releaseVersionCheck = resolve;
    });
  }

  public releaseVersionCheck(): void {
    this.#releaseVersionCheck?.();
  }

  public override async run(
    executable: string,
    args: readonly string[],
    options?: CommandRunOptions,
  ): Promise<CommandResult> {
    if (
      executable === "copilot" &&
      args.length === 1 &&
      args[0] === "--version"
    ) {
      this.#reportVersionCheckStarted?.();
      await this.#versionCheckGate;
    }
    return super.run(executable, args, options);
  }
}

describe("Copilot operational adapter", () => {
  it("installs idempotently and preserves JSONC settings", async () => {
    const root = await createTemporaryDirectory();
    const dataRoot = join(root, "data-root");
    const copilotHome = join(root, "copilot-home");
    const settingsPath = join(copilotHome, "settings.json");
    await mkdir(copilotHome, {
      recursive: true,
    });
    await writeFile(
      settingsPath,
      `{
  // Preserve this user setting.
  "theme": "dark",
}
`,
      "utf8",
    );
    const runner = new FakeCommandRunner();
    const marketplaceRoot = join(
      dataRoot,
      "integration",
      "copilot-marketplace",
    );
    const adapter = new CopilotCliAdapter({
      cliBinPath: "C:\\tools\\provenloop\\bin.js",
      commandRunner: runner,
      copilotHome,
      dataRoot,
      environment: {},
      extensionModuleUrl:
        "file:///C:/tools/provenloop/extension-entry.js",
      marketplace: {
        name: "provenloop-marketplace",
        source: marketplaceRoot,
        writeLocalAssets: true,
      },
      platform: "win32",
    });

    await expect(adapter.install()).resolves.toMatchObject({
      status: "changed",
    });
    await expect(adapter.install()).resolves.toMatchObject({
      status: "unchanged",
    });
    await expect(adapter.upgrade()).resolves.toMatchObject({
      status: "changed",
    });
    expect(runner.calls).toContain(
      "copilot plugin marketplace update provenloop-marketplace",
    );
    expect(runner.calls).toContain(
      `copilot plugin marketplace add ${marketplaceRoot}`,
    );

    const settings = await readFile(settingsPath, "utf8");
    expect(settings).toContain("// Preserve this user setting.");
    expect(settings).toContain('"experimental": true');
    const plugin = JSON.parse(
      await readFile(
        join(marketplaceRoot, "plugins", "provenloop", "plugin.json"),
        "utf8",
      ),
    ) as Readonly<Record<string, unknown>>;
    const mcp = await readFile(
      join(marketplaceRoot, "plugins", "provenloop", ".mcp.json"),
      "utf8",
    );
    const extension = await readFile(
      join(
        marketplaceRoot,
        "plugins",
        "provenloop",
        "extensions",
        "event-capture",
        "extension.mjs",
      ),
      "utf8",
    );
    expect(plugin).toMatchObject({
      extensions: "extensions/",
      mcpServers: ".mcp.json",
      name: "provenloop",
    });
    expect(mcp).toContain('"mcp"');
    expect(mcp).toContain('"serve"');
    expect(extension).toContain("@github/copilot-sdk/extension");
    expect(extension).toContain(
      "file:///C:/tools/provenloop/extension-entry.js",
    );

    const status = await adapter.status();
    expect(status).toMatchObject({
      installed: true,
      marketplaceRegistered: true,
      pluginEnabled: true,
      pluginInstalled: true,
    });
    expect(status.capabilities.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          availability: "available",
          capability: "capture",
          enabled: true,
        }),
        expect.objectContaining({
          availability: "available",
          capability: "worker",
          enabled: true,
        }),
        expect.objectContaining({
          availability: "available",
          capability: "retrieval",
          enabled: false,
        }),
      ]),
    );
  });

  it("enables, disables, uninstalls, and purges without data loss", async () => {
    const root = await createTemporaryDirectory();
    const dataRoot = join(root, "data-root");
    const copilotHome = join(root, "copilot-home");
    const runner = new FakeCommandRunner();
    const adapter = new CopilotCliAdapter({
      commandRunner: runner,
      copilotHome,
      dataRoot,
      environment: {},
      platform: "win32",
    });

    await adapter.install();
    const retainedPath = join(dataRoot, "data", "retained.txt");
    await writeFile(retainedPath, "retain", "utf8");

    await expect(adapter.disable("capture")).resolves.toMatchObject({
      status: "changed",
    });
    expect(runner.pluginEnabled).toBe(false);
    await expect(adapter.disable("capture")).resolves.toMatchObject({
      status: "unchanged",
    });
    await expect(adapter.enable("capture")).resolves.toMatchObject({
      status: "changed",
    });
    expect(runner.pluginEnabled).toBe(true);
    await expect(adapter.enable("worker")).resolves.toMatchObject({
      status: "unchanged",
    });
    await expect(adapter.disable("worker")).resolves.toMatchObject({
      status: "changed",
    });

    await expect(
      adapter.uninstall({
        purge: false,
      }),
    ).resolves.toMatchObject({
      status: "changed",
    });
    await expect(access(retainedPath)).resolves.toBeUndefined();
    await expect(
      access(join(dataRoot, "integration")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    const settings = await readFile(
      join(copilotHome, "settings.json"),
      "utf8",
    );
    expect(settings).not.toContain('"experimental": true');

    await writeFile(
      join(copilotHome, "settings.json"),
      `{
  "experimental": true
}
`,
      "utf8",
    );
    await adapter.install();
    await adapter.uninstall({
      purge: false,
    });
    expect(
      await readFile(join(copilotHome, "settings.json"), "utf8"),
    ).toContain('"experimental": true');

    await adapter.install();
    await expect(
      adapter.uninstall({
        purge: true,
      }),
    ).resolves.toMatchObject({
      status: "changed",
    });
    await expect(access(dataRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("supports installation with automatic collection disabled", async () => {
    const root = await createTemporaryDirectory();
    const runner = new FakeCommandRunner();
    const adapter = new CopilotCliAdapter({
      commandRunner: runner,
      copilotHome: join(root, "copilot-home"),
      dataRoot: join(root, "data-root"),
      environment: {},
      platform: "win32",
    });

    await expect(
      adapter.install({
        autoCollect: false,
      }),
    ).resolves.toMatchObject({
      status: "changed",
    });
    expect(runner.calls).toContain(
      "copilot plugin marketplace add " +
        "cubika/ProvenLoop#v0.1.0-alpha.0.6",
    );
    const status = await adapter.status();
    expect(status.pluginInstalled).toBe(true);
    expect(
      status.capabilities.capabilities.filter((capability) =>
        [
          "capture",
          "worker",
        ].includes(capability.capability),
      ),
    ).toEqual([
      expect.objectContaining({
        capability: "capture",
        enabled: false,
      }),
      expect.objectContaining({
        capability: "worker",
        enabled: false,
      }),
    ]);
    await expect(adapter.install()).resolves.toMatchObject({
      status: "unchanged",
    });
    const repeated = await adapter.status();
    expect(
      repeated.capabilities.capabilities.filter((capability) =>
        [
          "capture",
          "worker",
        ].includes(capability.capability),
      ),
    ).toEqual([
      expect.objectContaining({
        capability: "capture",
        enabled: false,
      }),
      expect.objectContaining({
        capability: "worker",
        enabled: false,
      }),
    ]);
  });

  it("serializes concurrent capability changes", async () => {
    const root = await createTemporaryDirectory();
    const dataRoot = join(root, "data-root");
    const adapter = new CopilotCliAdapter({
      commandRunner: new FakeCommandRunner(),
      copilotHome: join(root, "copilot-home"),
      dataRoot,
      environment: {},
      platform: "win32",
    });
    await adapter.install();

    await Promise.all([
      adapter.enable("worker"),
      adapter.disable("capture"),
    ]);

    const capabilities = await adapter.capabilities();
    expect(
      capabilities.capabilities.find(
        (capability) => capability.capability === "worker",
      ),
    ).toMatchObject({
      enabled: true,
    });
    expect(
      capabilities.capabilities.find(
        (capability) => capability.capability === "capture",
      ),
    ).toMatchObject({
      enabled: false,
    });
  });

  it("bounds Copilot lifecycle commands", async () => {
    const root = await createTemporaryDirectory();
    const runner = new FakeCommandRunner();
    const adapter = new CopilotCliAdapter({
      commandRunner: runner,
      copilotHome: join(root, "copilot-home"),
      dataRoot: join(root, "data-root"),
      environment: {},
      platform: "win32",
    });

    await adapter.install();
    expect(
      runner.options
        .filter((call) => call.command.startsWith("copilot "))
        .every((call) => call.timeoutMs === 15_000),
    ).toBe(true);
  });

  it("restores the prior integration when plugin replacement fails", async () => {
      const root = await createTemporaryDirectory();
      const dataRoot = join(root, "data-root");
      const locatorPath = join(root, "runtime.json");
      const runner = new FakeCommandRunner();
      const adapter = new CopilotCliAdapter({
        cliBinPath: "C:\\previous-runtime\\bin.js",
        commandRunner: runner,
        copilotHome: join(root, "copilot-home"),
        dataRoot,
        environment: {},
        extensionModuleUrl:
          "file:///C:/previous-runtime/extension-entry.js",
        integrationLocatorPath: locatorPath,
        platform: "win32",
      });
      await adapter.install();
      const previousLocator = await readFile(locatorPath, "utf8");
      runner.marketplaceSource = "cubika/ProvenLoop#v0.1.0-alpha.0.4";
      runner.pluginVersion = "0.1.0-alpha.0.4";
      runner.failures.set(
        "copilot plugin marketplace add cubika/ProvenLoop#v0.1.0-alpha.0.6",
        {
          exitCode: 1,
          stderr: "network unavailable",
          stdout: "",
        },
      );

      await expect(adapter.upgrade()).rejects.toThrow(
        "prior integration was restored",
      );
      expect(runner.marketplaceRegistered).toBe(true);
      expect(runner.marketplaceSource).toBe(
        "cubika/ProvenLoop#v0.1.0-alpha.0.4",
      );
      expect(runner.pluginInstalled).toBe(true);
      expect(runner.pluginEnabled).toBe(true);
      await expect(readFile(locatorPath, "utf8")).resolves.toBe(
        previousLocator,
      );
  });

  it("validates managed Copilot settings before uninstalling", async () => {
      const root = await createTemporaryDirectory();
      const copilotHome = join(root, "copilot-home");
      const runner = new FakeCommandRunner();
      const adapter = new CopilotCliAdapter({
        commandRunner: runner,
        copilotHome,
        dataRoot: join(root, "data-root"),
        environment: {},
        platform: "win32",
      });
      await adapter.install();
      await writeFile(
        join(copilotHome, "settings.json"),
        "{ invalid",
        "utf8",
      );
      const callsBefore = runner.calls.length;

      await expect(
        adapter.uninstall({
          purge: false,
        }),
      ).rejects.toThrow("Copilot settings are malformed");
      expect(runner.calls).toHaveLength(callsBefore);
      expect(runner.marketplaceRegistered).toBe(true);
      expect(runner.pluginInstalled).toBe(true);
  });

  it("waits for every active Extension to acknowledge a purge", async () => {
      const root = await createTemporaryDirectory();
      const registration = await registerActiveExtension(
        root,
        "extension-session",
      );
      const shutdown = await beginExtensionShutdown(root);
      expect(await isExtensionShutdownRequested(root)).toBe(true);
      const waiting = waitForActiveExtensionsToStop(root, 1_000);

      await registration.release();
      await expect(waiting).resolves.toBeUndefined();
      await shutdown.cancel();
  });

  it("does not recreate a data root purged during Extension startup", async () => {
      const root = await createTemporaryDirectory();
      const marker = join(root, ".provenloop-root.json");
      await writeFile(marker, "{}\n", "utf8");
      const shutdown = await beginExtensionShutdown(root);
      const starting = registerActiveExtension(
        root,
        "starting-during-purge",
        {
          assertDataRoot: () => access(marker),
        },
      );

      await rm(root, {
        force: true,
        recursive: true,
      });
      await shutdown.cancel();
      await expect(starting).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(access(root)).rejects.toMatchObject({
        code: "ENOENT",
      });
  });

  it("refuses to purge while the capture worker lease is active", async () => {
    const root = await createTemporaryDirectory();
    const dataRoot = join(root, "data-root");
    const adapter = new CopilotCliAdapter({
      commandRunner: new FakeCommandRunner(),
      copilotHome: join(root, "copilot-home"),
      dataRoot,
      environment: {},
      platform: "win32",
    });
    await adapter.install();
    await adapter.enable("worker");
    const leaseName =
      await resolveWindowsCaptureWorkerLeaseName(dataRoot);
    const lease = await new WindowsNamedPipeLeaseProvider(
      leaseName,
    ).tryAcquire();
    if (lease === undefined) {
      throw new Error("Expected to acquire the worker lease.");
    }
    try {
      await expect(
        adapter.uninstall({
          purge: true,
        }),
      ).rejects.toThrow(
        "Cannot purge while the capture worker is active.",
      );
      await expect(access(dataRoot)).resolves.toBeUndefined();
    } finally {
      await lease.release();
    }

    await expect(
      adapter.uninstall({
        purge: true,
      }),
    ).resolves.toMatchObject({
      status: "changed",
    });
    await expect(access(dataRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses to purge while retrieval or deletion holds the projection lease", async () => {
    const root = await createTemporaryDirectory();
    const dataRoot = join(root, "data-root");
    const adapter = new CopilotCliAdapter({
      commandRunner: new FakeCommandRunner(),
      copilotHome: join(root, "copilot-home"),
      dataRoot,
      platform: "win32",
    });

    await adapter.install();
    const provider = new WindowsNamedPipeLeaseProvider(
      await resolveWindowsProvenLoopLeaseName(
        dataRoot,
        "knowledge-projection",
      ),
    );
    const lease = await provider.tryAcquire();
    if (lease === undefined) {
      throw new Error(
        "Expected to acquire the Knowledge projection lease.",
      );
    }
    try {
      await expect(
        adapter.uninstall({
          purge: true,
        }),
      ).rejects.toThrow(
        "Cannot purge while retrieval, deletion, or Knowledge projection is active.",
      );
      await expect(access(dataRoot)).resolves.toBeUndefined();
      await expect(adapter.status()).resolves.toMatchObject({
        installed: true,
        marketplaceRegistered: true,
        pluginEnabled: true,
        pluginInstalled: true,
      });
    } finally {
      await lease.release();
    }

    await expect(
      adapter.uninstall({
        purge: true,
      }),
    ).resolves.toMatchObject({
      status: "changed",
    });
    await expect(access(dataRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("stops active Extension capture before purging the data root", async () => {
    const root = await createTemporaryDirectory();
    const dataRoot = join(root, "data-root");
    const localAppData = join(root, "local-app-data");
    const environment = {
      LOCALAPPDATA: localAppData,
      SESSION_ID: "active-purge-session",
    };
    const runner = new FakeCommandRunner();
    const adapter = new CopilotCliAdapter({
      commandRunner: runner,
      copilotHome: join(root, "copilot-home"),
      dataRoot,
      environment,
      platform: "win32",
    });
    await adapter.install();
    await expect(
      runInstalledCopilotExtension({
        commandRunner: runner,
        copilotHome: join(root, "copilot-home"),
        dataRoot,
        environment,
        joinSession: async () => ({
          on: () => undefined,
        }),
      }),
    ).resolves.toEqual({
      status: "started",
    });

    await adapter.uninstall({
      purge: true,
    });
    await new Promise<void>((resolveDelay) => {
      setTimeout(resolveDelay, 1_200);
    });

    await expect(access(dataRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      access(
        join(
          localAppData,
          "ProvenLoopIntegration",
          "runtime.json",
        ),
      ),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("registers an Extension before its Copilot version check", async () => {
    const root = await createTemporaryDirectory();
    const dataRoot = join(root, "data-root");
    const environment = {
      LOCALAPPDATA: join(root, "local-app-data"),
      SESSION_ID: "starting-extension-session",
    };
    const adapter = new CopilotCliAdapter({
      commandRunner: new FakeCommandRunner(),
      copilotHome: join(root, "copilot-home"),
      dataRoot,
      environment,
      platform: "win32",
    });
    await adapter.install();
    const runner = new BlockingVersionCommandRunner();
    const starting = runInstalledCopilotExtension({
      commandRunner: runner,
      copilotHome: join(root, "copilot-home"),
      dataRoot,
      environment,
      joinSession: async () => ({
        on: () => undefined,
      }),
    });

    await runner.versionCheckStarted;
    expect(
      await readdir(
        join(dataRoot, "data", "extension-sessions"),
      ),
    ).toHaveLength(1);

    runner.releaseVersionCheck();
    await expect(starting).resolves.toEqual({
      status: "started",
    });
    await expect(
      adapter.uninstall({
        purge: true,
      }),
    ).resolves.toMatchObject({
      status: "changed",
    });
  });

  it("reports unsupported Copilot versions without mutating Copilot", async () => {
    const root = await createTemporaryDirectory();
    const runner = new FakeCommandRunner();
    runner.version = "1.0.70-0";
    const adapter = new CopilotCliAdapter({
      commandRunner: runner,
      copilotHome: join(root, "copilot-home"),
      dataRoot: join(root, "data-root"),
      environment: {},
      platform: "win32",
    });

    await expect(adapter.install()).resolves.toMatchObject({
      status: "incompatible",
    });
    expect(
      runner.calls.some((call) => call.includes("plugin install")),
    ).toBe(false);
    const matrix = await adapter.capabilities();
    expect(matrix).toMatchObject({
      compatibility: "incompatible",
      installedVersion: "1.0.70-0",
    });
    expect(
      matrix.capabilities.find(
        (capability) => capability.capability === "capture",
      ),
    ).toMatchObject({
      availability: "incompatible",
      enabled: false,
    });
  });

  it("installs with newer compatible Copilot versions", async () => {
    const root = await createTemporaryDirectory();
    const runner = new FakeCommandRunner();
    runner.version = "1.0.83-4";
    const adapter = new CopilotCliAdapter({
      commandRunner: runner,
      copilotHome: join(root, "copilot-home"),
      dataRoot: join(root, "data-root"),
      environment: {},
      platform: "win32",
    });

    await expect(adapter.install()).resolves.toMatchObject({
      status: "changed",
    });
    await expect(adapter.capabilities()).resolves.toMatchObject({
      compatibility: "supported",
      installedVersion: "1.0.83-4",
      capture: {
        adapterVersion: "1.0.83-4",
      },
    });
    await expect(adapter.doctor({
      online: true,
    })).resolves.toMatchObject({
      checks: expect.arrayContaining([
        expect.objectContaining({
          id: "copilot.version",
          message: "GitHub Copilot CLI 1.0.83-4 is verified.",
          status: "pass",
        }),
      ]),
    });
    runner.version = "1.1.0";
    await expect(adapter.doctor({
      online: true,
    })).resolves.toMatchObject({
      checks: expect.arrayContaining([
        expect.objectContaining({
          id: "copilot.version",
          message:
            "GitHub Copilot CLI 1.1.0 is compatible but has not yet completed ProvenLoop verification.",
          status: "warn",
        }),
      ]),
    });
  });

  it("stops before changing Copilot configuration when required commands are unavailable", async () => {
    const root = await createTemporaryDirectory();
    const copilotHome = join(root, "copilot-home");
    const runner = new FakeCommandRunner();
    runner.unsupportedHelpCommand = "copilot plugins enable --help";
    const adapter = new CopilotCliAdapter({
      commandRunner: runner,
      copilotHome,
      dataRoot: join(root, "data-root"),
      environment: {},
      platform: "win32",
    });

    await expect(adapter.install()).rejects.toThrow(
      "Copilot Plugin enablement support failed: Unknown command.",
    );
    expect(
      runner.calls.some((call) =>
        call.startsWith("copilot plugin marketplace add "),
      ),
    ).toBe(false);
    await expect(access(join(copilotHome, "settings.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("resolves Git identity and suppresses registered internal sessions", async () => {
    const root = await createTemporaryDirectory();
    const dataRoot = join(root, "data-root");
    const runner = new FakeCommandRunner();
    const adapter = new CopilotCliAdapter({
      commandRunner: runner,
      copilotHome: join(root, "copilot-home"),
      dataRoot,
      environment: {},
      platform: "win32",
    });
    await adapter.install();
    await registerInternalCopilotSession(dataRoot, "session-internal");

    await expect(
      adapter.resolveSession({
        adapterVersion: "1.0.82-0",
        cwd: runner.gitRoot,
        environment: {},
        sessionId: "session-internal",
      }),
    ).resolves.toEqual({
      branch: "feat/batch5-operational-cli-adapter",
      commitSha: "ac758f82454bc729604dbf533d9e3b08460385de",
      commitParents: [
        "0123456789abcdef0123456789abcdef01234567",
      ],
      internalSession: true,
      repositoryId: resolve(runner.gitRoot, ".git"),
      repositoryRemote: "https://example.test/ProvenLoop.git",
      repositoryRoot: runner.gitRoot,
      sessionId: "session-internal",
      worktreePath: runner.gitRoot,
    });
  });

  it("keeps the installed Extension fail-open when capture is disabled", async () => {
    const root = await createTemporaryDirectory();
    const dataRoot = join(root, "data-root");
    const runner = new FakeCommandRunner();
    const adapter = new CopilotCliAdapter({
      commandRunner: runner,
      copilotHome: join(root, "copilot-home"),
      dataRoot,
      environment: {},
      platform: "win32",
    });
    await adapter.install();
    await adapter.disable("capture");
    let joined = false;

    await expect(
      runInstalledCopilotExtension({
        dataRoot,
        environment: {
          SESSION_ID: "session-1",
        },
        joinSession: async () => {
          joined = true;
          throw new Error("joinSession should not be called");
        },
      }),
    ).resolves.toEqual({
      status: "disabled",
    });
    expect(joined).toBe(false);
  });

  it("rechecks the live Copilot version before Extension capture starts", async () => {
    const root = await createTemporaryDirectory();
    const dataRoot = join(root, "data-root");
    const copilotHome = join(root, "copilot-home");
    const runner = new FakeCommandRunner();
    const adapter = new CopilotCliAdapter({
      commandRunner: runner,
      copilotHome,
      dataRoot,
      environment: {},
      platform: "win32",
    });
    await adapter.install();
    runner.version = "1.0.70-0";
    let joined = false;

    await expect(
      runInstalledCopilotExtension({
        commandRunner: runner,
        copilotHome,
        dataRoot,
        environment: {
          SESSION_ID: "session-1",
        },
        joinSession: async () => {
          joined = true;
          throw new Error("joinSession should not be called");
        },
      }),
    ).resolves.toEqual({
      status: "incompatible",
    });
    expect(joined).toBe(false);
  });

  it("reports external plugin deactivation in effective capabilities", async () => {
    const root = await createTemporaryDirectory();
    const runner = new FakeCommandRunner();
    const adapter = new CopilotCliAdapter({
      commandRunner: runner,
      copilotHome: join(root, "copilot-home"),
      dataRoot: join(root, "data-root"),
      environment: {},
      platform: "win32",
    });

    await adapter.install();
    runner.pluginEnabled = false;

    const status = await adapter.status();
    expect(
      status.capabilities.capabilities.find(
        (capability) => capability.capability === "capture",
      ),
    ).toMatchObject({
      enabled: false,
      lastError: "The ProvenLoop Copilot plugin is disabled.",
    });
    await expect(adapter.enable("capture")).resolves.toMatchObject({
      status: "changed",
    });
    expect(runner.pluginEnabled).toBe(true);
  });

  it("fails closed when the marketplace plugin version differs from the runtime", async () => {
    const root = await createTemporaryDirectory();
    const runner = new FakeCommandRunner();
    runner.marketplaceRegistered = true;
    runner.pluginEnabled = true;
    runner.pluginInstalled = true;
    runner.pluginVersion = "0.1.0-alpha.1";
    const adapter = new CopilotCliAdapter({
      commandRunner: runner,
      copilotHome: join(root, "copilot-home"),
      dataRoot: join(root, "data-root"),
      environment: {},
      platform: "win32",
    });

    await expect(adapter.install()).rejects.toThrow(
      "does not match runtime 0.1.0-alpha.0.6",
    );
    await expect(adapter.status()).resolves.toMatchObject({
      installed: false,
      pluginVersion: "0.1.0-alpha.1",
    });
  });

  it("replaces a same-name marketplace from an untrusted source", async () => {
    const root = await createTemporaryDirectory();
    const runner = new FakeCommandRunner();
    runner.marketplaceRegistered = true;
    runner.marketplaceSource = "attacker/untrusted";
    runner.pluginEnabled = true;
    runner.pluginInstalled = true;
    const adapter = new CopilotCliAdapter({
      commandRunner: runner,
      copilotHome: join(root, "copilot-home"),
      dataRoot: join(root, "data-root"),
      environment: {},
      platform: "win32",
    });

    await expect(adapter.install()).resolves.toMatchObject({
      status: "changed",
    });
    expect(runner.calls).toEqual(
      expect.arrayContaining([
        "copilot plugin uninstall provenloop@provenloop-marketplace",
        "copilot plugin marketplace remove provenloop-marketplace",
        "copilot plugin marketplace add " +
          "cubika/ProvenLoop#v0.1.0-alpha.0.6",
      ]),
    );
  });

  it("reads the pinned marketplace ref from Copilot settings", async () => {
    const root = await createTemporaryDirectory();
    const copilotHome = join(root, "copilot-home");
    await mkdir(copilotHome, {
      recursive: true,
    });
    await writeFile(
      join(copilotHome, "settings.json"),
      `${JSON.stringify({
        extraKnownMarketplaces: {
          "provenloop-marketplace": {
            source: {
              ref: "v0.1.0-alpha.0.6",
              repo: "cubika/ProvenLoop",
              source: "github",
            },
          },
        },
      }, null, 2)}\n`,
      "utf8",
    );
    const runner = new FakeCommandRunner();
    runner.marketplaceRegistered = true;
    runner.marketplaceSource = "cubika/ProvenLoop";
    runner.pluginEnabled = true;
    runner.pluginInstalled = true;
    const adapter = new CopilotCliAdapter({
      commandRunner: runner,
      copilotHome,
      dataRoot: join(root, "data-root"),
      environment: {},
      platform: "win32",
    });

    await expect(adapter.install()).resolves.toMatchObject({
      status: "changed",
    });
    expect(runner.calls).not.toContain(
      "copilot plugin marketplace remove provenloop-marketplace",
    );
  });

  it("does not report uninstall success when registration probes fail", async () => {
    const root = await createTemporaryDirectory();
    const dataRoot = join(root, "data-root");
    const runner = new FakeCommandRunner();
    const adapter = new CopilotCliAdapter({
      commandRunner: runner,
      copilotHome: join(root, "copilot-home"),
      dataRoot,
      environment: {},
      platform: "win32",
    });
    await adapter.install();
    runner.registrationProbeFailure = true;

    await expect(
      adapter.uninstall({
        purge: false,
      }),
    ).rejects.toThrow("Copilot registration probe failed");
    await expect(
      access(dataRoot),
    ).resolves.toBeUndefined();
  });

  it("keeps a failed first install recoverable", async () => {
    const root = await createTemporaryDirectory();
    const dataRoot = join(root, "data-root");
    const runner = new FakeCommandRunner();
    runner.registrationProbeFailure = true;
    const adapter = new CopilotCliAdapter({
      commandRunner: runner,
      copilotHome: join(root, "copilot-home"),
      dataRoot,
      environment: {},
      platform: "win32",
    });

    await expect(adapter.install()).rejects.toThrow(
      "Copilot registration probe failed",
    );
    await expect(
      access(join(dataRoot, "data", "adapter-state.json")),
    ).resolves.toBeUndefined();
    runner.registrationProbeFailure = false;
    await expect(
      adapter.uninstall({
        purge: true,
      }),
    ).resolves.toMatchObject({
      status: "changed",
    });
    await expect(access(dataRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps concurrent internal Session registrations independent", async () => {
    const root = await createTemporaryDirectory();
    const dataRoot = join(root, "data-root");
    const runner = new FakeCommandRunner();
    const adapter = new CopilotCliAdapter({
      commandRunner: runner,
      copilotHome: join(root, "copilot-home"),
      dataRoot,
      environment: {},
      platform: "win32",
    });
    await adapter.install();
    await Promise.all([
      registerInternalCopilotSession(dataRoot, "session-a"),
      registerInternalCopilotSession(dataRoot, "session-b"),
    ]);

    const identities = await Promise.all(
      [
        "session-a",
        "session-b",
      ].map((sessionId) =>
        adapter.resolveSession({
          adapterVersion: "1.0.82-0",
          cwd: runner.gitRoot,
          environment: {},
          sessionId,
        }),
      ),
    );
    expect(
      identities.map((identity) => identity.internalSession),
    ).toEqual([
      true,
      true,
    ]);
  });

  it("refuses to adopt or purge an unowned existing directory", async () => {
    const root = await createTemporaryDirectory();
    const dataRoot = join(root, "existing-directory");
    const retainedPath = join(dataRoot, "user-file.txt");
    await mkdir(dataRoot, {
      recursive: true,
    });
    await writeFile(retainedPath, "retain", "utf8");
    const adapter = new CopilotCliAdapter({
      commandRunner: new FakeCommandRunner(),
      copilotHome: join(root, "copilot-home"),
      dataRoot,
      environment: {},
      platform: "win32",
    });

    await expect(adapter.enable("worker")).resolves.toMatchObject({
      status: "incompatible",
    });
    await expect(
      access(join(dataRoot, "data", "adapter-state.json")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(adapter.install()).rejects.toThrow(
      "Refusing to use unowned existing data root",
    );
    await expect(
      adapter.uninstall({
        purge: true,
      }),
    ).rejects.toThrow("ownership marker is missing or invalid");
    await expect(access(retainedPath)).resolves.toBeUndefined();
  });

  it("reports operational health including the synthetic capture path", async () => {
    const root = await createTemporaryDirectory();
    const runner = new FakeCommandRunner();
    const adapter = new CopilotCliAdapter({
      commandRunner: runner,
      copilotHome: join(root, "copilot-home"),
      dataRoot: join(root, "data-root"),
      environment: {},
      platform: "win32",
    });
    await adapter.install();

    const health = await adapter.doctor();
    expect(health.status).toBe("degraded");
    expect(health.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "storage.sqlite",
          status: "pass",
        }),
        expect.objectContaining({
          id: "capture.queue",
          status: "pass",
        }),
        expect.objectContaining({
          id: "capture.synthetic",
          status: "pass",
        }),
        expect.objectContaining({
          id: "copilot.provider",
          status: "warn",
        }),
      ]),
    );
  });

  it("classifies opt-in online provider degradation without persisting output", async () => {
    const root = await createTemporaryDirectory();
    const runner = new FakeCommandRunner();
    const adapter = new CopilotCliAdapter({
      commandRunner: runner,
      copilotHome: join(root, "copilot-home"),
      dataRoot: join(root, "data-root"),
      environment: {},
      platform: "win32",
    });
    await adapter.install();

    await expect(
      adapter.doctor({
        online: true,
      }),
    ).resolves.toMatchObject({
      providerStatus: "available",
    });

    runner.providerResult = {
      exitCode: 1,
      stderr: "Authentication required. Sign in first.",
      stdout: "",
    };
    const signedOut = await adapter.doctor({
      online: true,
    });
    expect(signedOut).toMatchObject({
      providerStatus: "signed_out",
    });
    expect(JSON.stringify(signedOut)).not.toContain(
      "Authentication required",
    );

    runner.providerResult = {
      exitCode: 1,
      stderr: "Rate limit exceeded.",
      stdout: "",
    };
    await expect(
      adapter.doctor({
        online: true,
      }),
    ).resolves.toMatchObject({
      providerStatus: "rate_limited",
    });

    runner.providerResult = {
      exitCode: 124,
      stderr: "Copilot command timed out.",
      stdout: "",
    };
    await expect(
      adapter.doctor({
        online: true,
      }),
    ).resolves.toMatchObject({
      providerStatus: "unavailable",
    });

    runner.version = "1.0.70-0";
    await expect(
      adapter.doctor({
        online: true,
      }),
    ).resolves.toMatchObject({
      providerStatus: "incompatible",
    });
  });
});
