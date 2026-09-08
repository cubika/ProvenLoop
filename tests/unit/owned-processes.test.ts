import { describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OwnedProvenLoopProcessController, type OwnedProvenLoopProcessOptions } from "../../packages/copilot-adapter/src/owned-processes.js";
import { SpawnCommandRunner, type CommandRunner } from "../../packages/copilot-adapter/src/command-runner.js";

const node = "C:/Program Files/nodejs/node.exe";
const cli = "C:/Runtime/0.10/node_modules/@provenloop/cli/dist/bin.js";
const plugin = "C:/Copilot/plugins/provenloop";
const dataRoot = "C:/Local/ProvenLoop";
const powershell = "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
const copilot = "C:/Copilot/copilot.exe";
const bootstrap = "C:/Copilot/preloads/extension_bootstrap.mjs";
const sid = "S-1-5-21-123-456-789-1001";
const parentCreatedAt = "134330447371180000";
const mcpArgs = [node, cli, "mcp", "serve", "--data-root", dataRoot];
const launcherArgs = [powershell, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", plugin + "/scripts/mcp-launcher.ps1"];
const identity = (pid: number, args: readonly string[], overrides: Record<string, unknown> = {}) => ({
  pid, parentPid: 200, createdAt: "134330447381180000", executable: args[0],
  commandLine: args.map((arg) => `"${arg}"`).join(" "), arguments: args, ownerSid: sid, ...overrides,
});
const snapshot = (processes: ReturnType<typeof identity>[]) => ({
  currentUserSid: sid,
  extensionParents: [identity(200, [copilot, "--log-dir", "C:/logs"], { parentPid: 0, createdAt: parentCreatedAt })],
  parents: [
    { pid: 100, parentPid: 50, executable: node }, { pid: 50, parentPid: 0, executable: powershell },
    { pid: 200, parentPid: 0, executable: copilot },
    ...processes.filter((entry) => ![50, 100, 200].includes(entry.pid)).map((entry) => ({ pid: entry.pid, parentPid: entry.parentPid, executable: entry.executable })),
  ],
  processes,
});
const harness = (responses: unknown[], overrides: Partial<OwnedProvenLoopProcessOptions> = {}) => {
  const calls: { readonly script: string; readonly payload: Record<string, unknown> }[] = [];
  const runner: CommandRunner = { run: async (executable, args, options) => {
    expect(executable).toBe(powershell); expect(options?.timeoutMs).toBe(15_000);
    const script = Buffer.from(args[3] ?? "", "base64").toString("utf16le");
    const encoded = script.split("FromBase64String(" + String.fromCharCode(39))[1]?.split(String.fromCharCode(39))[0];
    if (!encoded) throw new Error("Expected encoded structured scope.");
    calls.push({ script, payload: JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Record<string, unknown> });
    if (responses.length === 0) throw new Error("Unexpected command.");
    return { exitCode: 0, stdout: JSON.stringify(responses.shift()), stderr: "" };
  } };
  return { controller: new OwnedProvenLoopProcessController({ dataRoot, launcherDataRoot: dataRoot, pluginRoots: [plugin], runtimes: [{ nodeExecutable: node, cliBinPath: cli }],
    currentProcessId: 100, powerShellExecutable: powershell, platform: "win32", runner, ...overrides }), calls };
};

describe("verified ProvenLoop process cleanup", () => {
  it("selects only exact runtime and launcher signatures, never hosts, ancestors, other roots or extra arguments", async () => {
    const { controller, calls } = harness([snapshot([
      identity(301, mcpArgs), identity(302, launcherArgs), identity(200, [copilot, "--resume"], { parentPid: 0 }),
      identity(50, launcherArgs, { parentPid: 0 }), identity(100, mcpArgs, { parentPid: 50 }), identity(303, [...mcpArgs, "--eval", "code"]),
      identity(304, [...mcpArgs.slice(0, 5), dataRoot + "Other"]),
      identity(305, mcpArgs, { ownerSid: "S-1-5-21-987" }), identity(306, [node, cli + ".other", ...mcpArgs.slice(2)]),
      identity(307, [powershell, "-Command", launcherArgs[6] ?? ""]),
      identity(308, [...launcherArgs.slice(0, 6), plugin + "Other/scripts/mcp-launcher.ps1"]),
    ])]);
    const inventory = await controller.inspect();
    expect(inventory.processes.map((entry) => [entry.pid, entry.kind])).toEqual([[301, "mcp"], [302, "launcher"]]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.script).not.toContain("::TerminateProcess($handle");
  });

  it("accepts only log-attested extension children with their exact live parent and creation identity", async () => {
    const worker = { pid: 401, parentPid: 200, createdAt: "134330447381180000", parentCreatedAt, ownerSid: sid, executable: copilot, bootstrapPath: bootstrap, extensionPath: plugin + "/extensions/event-capture/extension.mjs" };
    const { controller } = harness([snapshot([identity(401, [copilot, bootstrap]), identity(402, [copilot, bootstrap]), identity(200, [copilot, bootstrap], { parentPid: 0 })])], { extensionWorkers: [worker] });
    expect((await controller.inspect()).processes).toMatchObject([{ pid: 401, kind: "extension" }]);
    const stale = harness([snapshot([identity(401, [copilot, bootstrap], { createdAt: "134330447381180010" })])], { extensionWorkers: [worker] });
    expect((await stale.controller.inspect()).processes).toEqual([]);
    const precise = harness([snapshot([identity(401, [copilot, bootstrap], { createdAt: "134330447381180009" })])], { extensionWorkers: [worker] });
    expect((await precise.controller.inspect()).processes).toEqual([]);
    const wrongParent = snapshot([identity(401, [copilot, bootstrap])]);
    wrongParent.extensionParents[0] = identity(200, [copilot, "--log-dir", "C:/logs"], { parentPid: 0, createdAt: "134330447371180001" });
    expect((await harness([wrongParent], { extensionWorkers: [worker] }).controller.inspect()).processes).toEqual([]);
    wrongParent.extensionParents[0] = identity(200, [copilot, "--log-dir", "C:/logs"], { parentPid: 0, createdAt: parentCreatedAt, ownerSid: "S-1-5-21-987" });
    expect((await harness([wrongParent], { extensionWorkers: [worker] }).controller.inspect()).processes).toEqual([]);
  });

  it("rechecks each process and uses a pinned handle for exact single-process termination", async () => {
    const process = identity(301, mcpArgs);
    const { controller, calls } = harness([snapshot([process]), snapshot([process]), { status: "stopped" }]);
    const inventory = await controller.inspect();
    expect(await controller.stop(inventory)).toEqual([{ pid: 301, status: "stopped" }]);
    expect(calls).toHaveLength(3);
    expect(calls[2]?.payload.target).toEqual(process);
    const script = calls[2]?.script ?? "";
    expect(script).toContain("::OpenProcess(0x101001");
    expect(script).toContain("::Creation($handle) -ne $target.createdAt");
    expect(script).toContain("$owner.Sid -ne $target.ownerSid");
    expect(script).toContain("$row.CommandLine -cne $target.commandLine");
    expect(script).toContain("::TerminateProcess($handle,0)");
    expect(script).not.toContain("taskkill"); expect(script).not.toContain("Stop-Process");
    await expect(controller.stop(inventory)).rejects.toThrow("Inspect owned processes");
  });

  it.each([
    { createdAt: "134330447381180001" }, { parentPid: 201 }, { commandLine: "changed" },
    { ownerSid: "S-1-5-21-987" },
  ])("does not terminate a changed process identity %j", async (change) => {
    const { controller, calls } = harness([snapshot([identity(301, mcpArgs)]), snapshot([identity(301, mcpArgs, change)])]);
    expect(await controller.stop(await controller.inspect())).toEqual([{ pid: 301, status: "identity_changed" }]);
    expect(calls).toHaveLength(2);
  });

  it("distinguishes an exited process from a live but newly unverified identity", async () => {
    const exited = harness([snapshot([identity(301, mcpArgs)]), snapshot([])]);
    expect(await exited.controller.stop(await exited.controller.inspect())).toEqual([{ pid: 301, status: "exited" }]);
    const changed = harness([snapshot([identity(301, mcpArgs)]), snapshot([identity(301, [node, "C:/unrelated.js"])])]);
    expect(await changed.controller.stop(await changed.controller.inspect())).toEqual([{ pid: 301, status: "identity_changed" }]);
    expect(changed.calls).toHaveLength(2);
  });

  it("does not select launchers without the verified locator data root", async () => {
    const { controller } = harness([snapshot([identity(301, launcherArgs)])], { launcherDataRoot: dataRoot + "Other" });
    expect((await controller.inspect()).processes).toEqual([]);
  });

  it("pins extension parent creation and owner again at termination", async () => {
    const worker = { pid: 401, parentPid: 200, createdAt: "134330447381180000", parentCreatedAt, ownerSid: sid, executable: copilot, bootstrapPath: bootstrap, extensionPath: plugin + "/extensions/event-capture/extension.mjs" };
    const observed = snapshot([identity(401, [copilot, bootstrap])]);
    const { controller, calls } = harness([observed, observed, { status: "identity_changed" }], { extensionWorkers: [worker] });
    expect(await controller.stop(await controller.inspect())).toEqual([{ pid: 401, status: "identity_changed" }]);
    expect(calls[2]?.payload.extensionParent).toEqual({ executable: copilot, createdAt: parentCreatedAt });
    expect(calls[2]?.script).toContain("::Creation($parentHandle) -ne $inputData.extensionParent.createdAt");
    expect(calls[2]?.script).toContain("$parentOwner.Sid -ne $target.ownerSid");
  });

  it("does not authorize a caller-fabricated or another controller's inventory", async () => {
    const { controller, calls } = harness([]);
    await expect(controller.stop({ processes: [] })).rejects.toThrow("Inspect owned processes");
    expect(calls).toHaveLength(0);
  });

  it("refuses incomplete ancestry and oversized inventory before selecting processes", async () => {
    const incomplete = snapshot([identity(301, mcpArgs)]);
    incomplete.parents = incomplete.parents.filter((row) => row.pid !== 50);
    await expect(harness([incomplete]).controller.inspect()).rejects.toThrow("ancestry cannot be verified");
    await expect(harness([snapshot(Array.from({ length: 65 }, (_, i) => identity(i + 300, mcpArgs)))]).controller.inspect()).rejects.toThrow("Invalid owned process inventory");
  });

  it.each([
    { createdAt: "9223372036854775808" }, { pid: 0 }, { arguments: ["a\0b"] },
    { executable: "C:/node.exe:alternate" }, { ownerSid: "S-1---" },
  ])("rejects malformed process inventory %j", async (change) => {
    await expect(harness([snapshot([identity(301, mcpArgs, change)])]).controller.inspect()).rejects.toThrow("Invalid process identity");
  });

  it("rejects malformed native ancestry attestations rather than silently ignoring them", async () => {
    await expect(harness([{ ...snapshot([]), protectedIds: [100, "50"] }]).controller.inspect()).rejects.toThrow("Invalid protected");
  });

  it.each(["C:relative", "C:/data/../elsewhere", "C:/data.", "\\\\server\\share"])(
    "rejects ambiguous cleanup scope %s", (path) => {
      expect(() => harness([], { dataRoot: path })).toThrow("absolute local Windows paths");
    },
  );

  it("stops following historical ancestors only after the native probe confirms they exited", async () => {
    const observed = snapshot([identity(301, mcpArgs)]);
    observed.parents = observed.parents.filter((row) => row.pid !== 50);
    const { controller } = harness([{ ...observed, protectedIds: [100, 50] }]);
    expect((await controller.inspect()).processes).toMatchObject([{ pid: 301, kind: "mcp" }]);
  });

  it.skipIf(process.platform !== "win32" || process.env.PROVENLOOP_PROCESS_FIXTURE !== "1")(
    "terminates only the exact owned Windows fixture and preserves unrelated processes", async () => {
      const root = await mkdtemp(join(process.cwd(), ".provenloop-owned-process-fixture-"));
      const fixtureBin = join(root, "dist", "bin.js");
      const fixtureData = join(root, "data");
      const children: ChildProcess[] = [];
      const start = async (args: readonly string[]): Promise<ChildProcess> => {
        const child = spawn(process.execPath, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        children.push(child);
        await new Promise<void>((resolveReady, reject) => {
          const finish = (error?: Error) => {
            clearTimeout(timeout);
            child.removeListener("error", onError);
            child.removeListener("exit", onExit);
            child.stdout?.removeListener("data", onReady);
            if (error) reject(error);
            else resolveReady();
          };
          const onError = (error: Error) => finish(error);
          const onExit = () => finish(new Error("Fixture exited before readiness."));
          const onReady = () => finish();
          const timeout = setTimeout(() => finish(new Error("Fixture startup timed out.")), 10_000);
          child.once("error", onError);
          child.once("exit", onExit);
          child.stdout?.once("data", onReady);
        });
        return child;
      };
      try {
        await mkdir(join(root, "dist"));
        await writeFile(fixtureBin, "process.stdout.write('ready'); setInterval(() => {}, 1000);", "utf8");
        const owned = await start([fixtureBin, "mcp", "serve", "--data-root", fixtureData]);
        const unrelated = await start([fixtureBin, "unrelated", "--data-root", fixtureData]);
        const otherRoot = await start([fixtureBin, "mcp", "serve", "--data-root", fixtureData + "-other"]);
        const native = new SpawnCommandRunner();
        const controller = new OwnedProvenLoopProcessController({
          dataRoot: fixtureData, pluginRoots: [], runtimes: [{ nodeExecutable: process.execPath, cliBinPath: fixtureBin }],
          // Allow CI startup contention without changing production inspection deadlines.
          runner: { run: (exe, args) => native.run(exe, args, { timeoutMs: 30_000 }) },
        });
        const inventory = await controller.inspect();
        expect(inventory.processes).toMatchObject([{ pid: owned.pid, kind: "mcp" }]);
        expect(inventory.processes).toHaveLength(1);
        expect(await controller.stop(inventory)).toEqual([{ pid: owned.pid, status: "stopped" }]);
        await expect.poll(() => owned.exitCode).not.toBeNull();
        expect(unrelated.exitCode).toBeNull();
        expect(otherRoot.exitCode).toBeNull();
        expect(unrelated.pid).toBeDefined();
        process.kill(unrelated.pid as number, 0);
        process.kill(process.pid, 0);
      } finally {
        for (const child of children) {
          if (!child.pid || child.exitCode !== null || child.signalCode !== null) continue;
          await new Promise<void>((resolveExit, reject) => {
            const timeout = setTimeout(() => reject(new Error("Disposable child cleanup timed out.")), 10_000);
            child.once("exit", () => { clearTimeout(timeout); resolveExit(); });
            child.kill();
          });
        }
        await rm(root, { recursive: true, force: true });
      }
    }, 120_000,
  );
});
