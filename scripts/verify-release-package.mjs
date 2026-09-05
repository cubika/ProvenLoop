import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  dirname,
  join,
  resolve,
} from "node:path";
import {
  fileURLToPath,
  pathToFileURL,
} from "node:url";
import { spawn } from "node:child_process";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const expectedVersion = JSON.parse(
  await readFile(
    resolve(repositoryRoot, "packages", "cli", "package.json"),
    "utf8",
  ),
).version;
const temporaryRoot = await mkdtemp(
  join(tmpdir(), "provenloop-package-"),
);
const packageDirectory = join(temporaryRoot, "package");
const installDirectory = join(temporaryRoot, "install");
const npmCliPath = process.env.npm_execpath;
if (!npmCliPath) {
  throw new Error(
    "npm_execpath is unavailable; run this check through npm.",
  );
}

const run = (
  executable,
  args,
  options = {},
) => new Promise((resolveRun, reject) => {
  const child = spawn(executable, args, {
    cwd: options.cwd ?? repositoryRoot,
    env: options.env ?? process.env,
    shell: false,
    windowsHide: true,
  });
  let stderr = "";
  let stdout = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  if (options.input !== undefined) {
    child.stdin.end(options.input);
  }
  child.once("error", reject);
  child.once("close", (exitCode) => {
    resolveRun({
      exitCode: exitCode ?? 1,
      stderr,
      stdout,
    });
  });
});

const requireSuccess = (
  result,
  operation,
) => {
  if (result.exitCode !== 0) {
    throw new Error(
      `${operation} failed with exit code ${result.exitCode}:\n` +
      `${result.stderr || result.stdout}`,
    );
  }
};

const pathExists = async (path) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

try {
  await mkdir(packageDirectory, {
    recursive: true,
  });
  const packed = await run(
    process.execPath,
    [
      npmCliPath,
      "pack",
      "--workspace",
      "@provenloop/cli",
      "--json",
      "--pack-destination",
      packageDirectory,
    ],
  );
  requireSuccess(packed, "npm pack");
  const [manifest] = JSON.parse(packed.stdout);
  if (
    manifest?.name !== "@provenloop/cli" ||
    manifest.version !== expectedVersion
  ) {
    throw new Error("npm pack returned unexpected package metadata.");
  }
  const files = new Set(
    manifest.files.map((file) => file.path),
  );
  for (const required of [
    "dist/bin.js",
    "dist/extension-entry.js",
    "dist/index.js",
    "fixtures/valid-supported-event/suite.json",
    "package.json",
  ]) {
    if (!files.has(required)) {
      throw new Error(`Packed artifact is missing ${required}.`);
    }
  }
  for (const path of files) {
    if (
      path.endsWith(".map") ||
      path.endsWith(".tsbuildinfo") ||
      path.includes("/src/") ||
      path.startsWith("tests/")
    ) {
      throw new Error(`Packed artifact contains forbidden path ${path}.`);
    }
  }

  const tarball = join(packageDirectory, manifest.filename);
  const installed = await run(
    process.execPath,
    [
      npmCliPath,
      "install",
      "--global",
      "--prefix",
      installDirectory,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      tarball,
    ],
  );
  requireSuccess(installed, "tarball install");

  const installedPackageRoot = join(
    installDirectory,
    "node_modules",
    "@provenloop",
    "cli",
  );
  const installedManifest = JSON.parse(
    await readFile(
      join(installedPackageRoot, "package.json"),
      "utf8",
    ),
  );
  if (
    installedManifest.version !== manifest.version ||
    installedManifest.dependencies !== undefined
  ) {
    throw new Error(
      "Installed package metadata is not self-contained.",
    );
  }

  const binaryPath = join(
    installedPackageRoot,
    "dist",
    "bin.js",
  );
  const commandShim = join(
    installDirectory,
    "provenloop.cmd",
  );
  const cliModule = await import(
    pathToFileURL(
      join(installedPackageRoot, "dist", "index.js"),
    ).href
  );
  const extensionModule = await import(
    pathToFileURL(
      join(
        installedPackageRoot,
        "dist",
        "extension-entry.js",
      ),
    ).href
  );
  if (
    typeof cliModule.runCli !== "function" ||
    typeof cliModule.runMcpServer !== "function" ||
    typeof cliModule.runCaptureWorkerOnce !== "function" ||
    typeof extensionModule.runInstalledCopilotExtension !== "function" ||
    typeof extensionModule.runProvenLoopCopilotExtension !== "function"
  ) {
    throw new Error("Installed runtime exports are incomplete.");
  }
  await Promise.all([
    access(binaryPath),
    access(commandShim),
  ]);
  const versionResult = await run(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `& '${commandShim.replaceAll("'", "''")}' version`,
    ],
  );
  requireSuccess(versionResult, "installed command shim");
  if (
    JSON.parse(versionResult.stdout).version !== expectedVersion
  ) {
    throw new Error(
      "Installed command shim reported the wrong version.",
    );
  }

  const fakeCopilotDirectory = join(
    temporaryRoot,
    "fake-copilot",
  );
  const fakeCopilotSource = join(
    fakeCopilotDirectory,
    "Program.cs",
  );
  const fakeCopilotExecutable = join(
    fakeCopilotDirectory,
    "copilot.exe",
  );
  const fakeCopilotState = join(
    fakeCopilotDirectory,
    "state.txt",
  );
  await mkdir(fakeCopilotDirectory, {
    recursive: true,
  });
  await writeFile(
    fakeCopilotSource,
    `using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

public static class Program
{
    public static int Main(string[] args)
    {
        var statePath = Environment.GetEnvironmentVariable(
            "PROVENLOOP_FAKE_COPILOT_STATE");
        if (string.IsNullOrWhiteSpace(statePath))
        {
            Console.Error.WriteLine("Fake Copilot state path is missing.");
            return 2;
        }
        var state = File.Exists(statePath)
            ? new HashSet<string>(File.ReadAllLines(statePath))
            : new HashSet<string>();
        var command = string.Join(" ", args);
        if (command == "--version")
        {
            Console.WriteLine("GitHub Copilot CLI 1.0.82-0.");
            return 0;
        }
        if (command.EndsWith(" --help"))
        {
            return 0;
        }
        if (command == "plugin marketplace list")
        {
            Console.WriteLine("Registered marketplaces:");
            if (state.Contains("marketplace"))
            {
                var source = state.FirstOrDefault(
                    value => value.StartsWith("source="));
                Console.WriteLine(
                    "  provenloop-marketplace (GitHub: " +
                    (source == null
                        ? "unknown"
                        : source.Substring("source=".Length)) +
                    ")");
            }
            return 0;
        }
        if (command == "plugin list")
        {
            Console.WriteLine("Live Plugins:");
            if (state.Contains("plugin"))
            {
                Console.WriteLine(
                    "  provenloop@provenloop-marketplace (v${expectedVersion}) (" +
                    (state.Contains("enabled") ? "enabled" : "disabled") +
                    ")");
            }
            return 0;
        }
        if (
            command ==
            "plugin marketplace add cubika/ProvenLoop#v${expectedVersion}"
        )
        {
            state.Add("marketplace");
            state.RemoveWhere(value => value.StartsWith("source="));
            state.Add("source=" + args[3]);
        }
        else if (command == "plugin marketplace remove provenloop-marketplace")
        {
            state.Remove("marketplace");
            state.RemoveWhere(value => value.StartsWith("source="));
            state.Remove("plugin");
            state.Remove("enabled");
        }
        else if (command == "plugin install provenloop@provenloop-marketplace")
        {
            state.Add("plugin");
            state.Add("enabled");
        }
        else if (command == "plugin uninstall provenloop@provenloop-marketplace")
        {
            state.Remove("plugin");
            state.Remove("enabled");
        }
        else if (
            command == "plugin marketplace update provenloop-marketplace" ||
            command == "plugin update provenloop@provenloop-marketplace")
        {
        }
        else
        {
            Console.Error.WriteLine("Unsupported fake command: " + command);
            return 1;
        }
        Directory.CreateDirectory(Path.GetDirectoryName(statePath));
        File.WriteAllLines(
            statePath,
            state.OrderBy(value => value).ToArray());
        return 0;
    }
}
`,
    "utf8",
  );
  const compiled = await run(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Add-Type " +
        `-Path '${fakeCopilotSource.replaceAll("'", "''")}' ` +
        `-OutputAssembly '${
          fakeCopilotExecutable.replaceAll("'", "''")
        }' -OutputType ConsoleApplication`,
    ],
  );
  requireSuccess(compiled, "fake Copilot compilation");

  const smokeEnvironment = {
    ...process.env,
    COPILOT_HOME: join(temporaryRoot, "copilot-home"),
    LOCALAPPDATA: join(temporaryRoot, "local-app-data"),
    PATH: `${fakeCopilotDirectory};${
      process.env.PATH ?? process.env.Path ?? ""
    }`,
    PROVENLOOP_FAKE_COPILOT_STATE: fakeCopilotState,
  };
  delete smokeEnvironment.Path;
  const dataRoot = join(
    temporaryRoot,
    "自定义数据",
  );
  await mkdir(smokeEnvironment.COPILOT_HOME, {
    recursive: true,
  });
  const originalSettings = `{
  // Preserve this user setting.
  "theme": "dark",
}
`;
  const settingsPath = join(
    smokeEnvironment.COPILOT_HOME,
    "settings.json",
  );
  await writeFile(settingsPath, originalSettings, "utf8");
  const runInstalledCli = (args) =>
    run(
      process.execPath,
      [
        binaryPath,
        ...args,
        "--data-root",
        dataRoot,
      ],
      {
        cwd: temporaryRoot,
        env: smokeEnvironment,
      },
    );

  requireSuccess(
    await runInstalledCli([
      "install",
    ]),
    "installed CLI install",
  );
  const locatorPath = join(
    smokeEnvironment.LOCALAPPDATA,
    "ProvenLoopIntegration",
    "runtime.json",
  );
  const runtimeLocator = JSON.parse(
    await readFile(locatorPath, "utf8"),
  );
  if (
    runtimeLocator.product !== "ProvenLoopRuntime" ||
    runtimeLocator.version !== expectedVersion ||
    runtimeLocator.dataRoot !== dataRoot ||
    runtimeLocator.cliBinPath !== binaryPath ||
    runtimeLocator.extensionModuleUrl !==
      pathToFileURL(
        join(
          installedPackageRoot,
          "dist",
          "extension-entry.js",
        ),
      ).href
  ) {
    throw new Error("Installed runtime locator is invalid.");
  }
  const mcpLauncherResult = await run(
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(
        repositoryRoot,
        "plugins",
        "provenloop",
        "scripts",
        "mcp-launcher.ps1",
      ),
    ],
    {
      env: smokeEnvironment,
      input:
        `${JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "initialize",
        })}\n`,
    },
  );
  requireSuccess(
    mcpLauncherResult,
    "PowerShell 5.1 MCP launcher",
  );
  if (
    !mcpLauncherResult.stdout.includes(
      `"version":"${expectedVersion}"`,
    )
  ) {
    throw new Error(
      "PowerShell 5.1 MCP launcher returned the wrong runtime.",
    );
  }
  const [
    marketplaceJson,
    pluginJson,
    mcpJson,
    extensionSource,
    mcpLauncher,
  ] = await Promise.all([
    readFile(
      join(
        repositoryRoot,
        ".github",
        "plugin",
        "marketplace.json",
      ),
      "utf8",
    ),
    readFile(
      join(
        repositoryRoot,
        "plugins",
        "provenloop",
        "plugin.json",
      ),
      "utf8",
    ),
    readFile(
      join(
        repositoryRoot,
        "plugins",
        "provenloop",
        ".mcp.json",
      ),
      "utf8",
    ),
    readFile(
      join(
        repositoryRoot,
        "plugins",
        "provenloop",
        "extensions",
        "event-capture",
        "extension.mjs",
      ),
      "utf8",
    ),
    readFile(
      join(
        repositoryRoot,
        "plugins",
        "provenloop",
        "scripts",
        "mcp-launcher.ps1",
      ),
      "utf8",
    ),
  ]);
  for (const manifestSource of [
    marketplaceJson,
    pluginJson,
  ]) {
    if (
      JSON.parse(manifestSource).version !== expectedVersion &&
      JSON.parse(manifestSource).metadata?.version !== expectedVersion
    ) {
      throw new Error("Installed plugin version is not release-bound.");
    }
  }
  const mcpManifest = JSON.parse(mcpJson);
  if (
    mcpManifest.mcpServers?.provenloop?.command !==
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" ||
    !mcpManifest.mcpServers?.provenloop?.args?.includes(
      "${PLUGIN_ROOT}\\scripts\\mcp-launcher.ps1",
    ) ||
    !extensionSource.includes("@github/copilot-sdk/extension") ||
    extensionSource.includes('from "@provenloop/') ||
    extensionSource.includes("provenloop runtime extension-path") ||
    !mcpLauncher.includes("$runtime.cliBinPath")
  ) {
    throw new Error(
      "Official plugin assets are not self-contained.",
    );
  }
  const retainedDataPath = join(
    dataRoot,
    "evaluation",
    "package-smoke-retained.txt",
  );
  await mkdir(dirname(retainedDataPath), {
    recursive: true,
  });
  await writeFile(retainedDataPath, "retained", "utf8");
  requireSuccess(
    await runInstalledCli([
      "upgrade",
    ]),
    "installed CLI upgrade",
  );
  if (!await pathExists(retainedDataPath)) {
    throw new Error("Upgrade did not preserve local data.");
  }
  requireSuccess(
    await runInstalledCli([
      "status",
    ]),
    "installed CLI status",
  );
  const doctor = await runInstalledCli([
    "doctor",
  ]);
  if (doctor.exitCode > 1) {
    throw new Error(
      `installed CLI doctor failed:\n${doctor.stderr || doctor.stdout}`,
    );
  }
  requireSuccess(
    await runInstalledCli([
      "worker",
      "run",
    ]),
    "installed CLI worker run",
  );
  requireSuccess(
    await runInstalledCli([
      "uninstall",
    ]),
    "installed CLI uninstall",
  );
  if (
    !await pathExists(dataRoot) ||
    await pathExists(join(dataRoot, "integration")) ||
    await pathExists(locatorPath) ||
    await readFile(settingsPath, "utf8") !== originalSettings
  ) {
    throw new Error(
      "Normal uninstall did not preserve data and restore settings.",
    );
  }
  requireSuccess(
    await runInstalledCli([
      "purge",
    ]),
    "installed CLI purge",
  );
  if (await pathExists(dataRoot)) {
    throw new Error("Purge did not remove the owned data root.");
  }

  const episodes = await run(
    process.execPath,
    [
      binaryPath,
      "eval",
      "episodes",
    ],
    {
      cwd: temporaryRoot,
    },
  );
  requireSuccess(episodes, "installed episode evaluation");
  const evaluation = await run(
    process.execPath,
    [
      binaryPath,
      "eval",
      "run",
      "--suite",
      "valid-supported-event",
      "--out",
      join(temporaryRoot, "evaluation"),
    ],
    {
      cwd: temporaryRoot,
    },
  );
  requireSuccess(evaluation, "installed evaluation fixture");

  console.log(
    `Verified ${manifest.name}@${manifest.version} ` +
    `(${manifest.size} bytes, ${files.size} files).`,
  );
} finally {
  await rm(temporaryRoot, {
    force: true,
    recursive: true,
  });
}
