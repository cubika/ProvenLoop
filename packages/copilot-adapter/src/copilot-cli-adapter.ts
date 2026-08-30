import { randomUUID } from "node:crypto";
import {
  access,
  constants,
  mkdir,
  readFile,
  rm,
  statfs,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  join,
  parse as parsePath,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

import {
  PROVENLOOP_CAPABILITIES,
  type AdapterCapabilityAvailability,
  type AdapterCapabilityMatrix,
  type AdapterCapabilityState,
  type AdapterCompatibility,
  type AdapterHealth,
  type AdapterHealthCheck,
  type AdapterOperationResult,
  type AdapterStatus,
  type AgentAdapter,
  type ProvenLoopCapability,
  type RuntimeContext,
  type SessionIdentity,
} from "@provenloop/contracts";
import {
  isProvenLoopInternalEnvironment,
  sanitizeDiagnostic,
} from "@provenloop/domain";
import {
  resolveWindowsProvenLoopPaths,
  WindowsCaptureQueue,
  WindowsNamedPipeLeaseProvider,
  type WindowsProvenLoopPaths,
} from "@provenloop/platform-windows";
import {
  CanonicalSqliteStore,
  DEFAULT_SQLITE_MIGRATIONS,
} from "@provenloop/storage-sqlite";

import { getCopilotCaptureCapability } from "./capabilities.js";
import {
  type CommandResult,
  type CommandRunner,
  SpawnCommandRunner,
} from "./command-runner.js";
import {
  CopilotEventMapper,
  type CopilotEventMappingResult,
} from "./event-mapper.js";
import {
  clearExperimentalSettingState,
  ensureExperimentalSetting,
  readCopilotAdapterState,
  readInternalSessionIds,
  removeInternalSessionId,
  restoreExperimentalSetting,
  setPersistedCapability,
  writeInternalSessionId,
  writeCopilotAdapterState,
  type PersistedCopilotAdapterState,
} from "./operational-state.js";

const COPILOT_MARKETPLACE_NAME = "provenloop-local";
const COPILOT_PLUGIN_NAME = "provenloop";
const COPILOT_PLUGIN_REFERENCE =
  `${COPILOT_PLUGIN_NAME}@${COPILOT_MARKETPLACE_NAME}`;
const COPILOT_PLUGIN_VERSION = "0.0.0";
const DATA_ROOT_MARKER_PRODUCT = "ProvenLoop";
const PLUGIN_CAPABILITIES = new Set<ProvenLoopCapability>([
  "capture",
  "retrieval",
]);

export interface CopilotCliAdapterOptions {
  readonly cliBinPath?: string;
  readonly commandRunner?: CommandRunner;
  readonly copilotHome?: string;
  readonly dataRoot: string;
  readonly environment?: Readonly<
    Record<string, string | undefined>
  >;
  readonly extensionModuleUrl?: string;
  readonly now?: () => Date;
  readonly platform?: NodeJS.Platform;
}

export class CopilotCommandError extends Error {
  public override readonly name = "CopilotCommandError";

  public constructor(operation: string, result: CommandResult) {
    const detail = sanitizeDiagnostic(
      result.stderr.trim() || result.stdout.trim() || "unknown failure",
    );
    super(`Copilot ${operation} failed: ${detail}`);
  }
}

const isRecord = (
  input: unknown,
): input is Readonly<Record<string, unknown>> =>
  input !== null && typeof input === "object" && !Array.isArray(input);

const optionalText = (value: string): string | undefined => {
  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
};

const compatibilityForVersion = (
  version: string | undefined,
): AdapterCompatibility => {
  if (version === undefined) {
    return "unavailable";
  }
  return getCopilotCaptureCapability(version) === undefined
    ? "incompatible"
    : "supported";
};

const capabilityAvailability = (
  capability: ProvenLoopCapability,
  compatibility: AdapterCompatibility,
): AdapterCapabilityAvailability => {
  if (capability === "worker") {
    return "unavailable";
  }
  if (capability === "capture") {
    return compatibility === "supported"
      ? "available"
      : compatibility;
  }
  return "unavailable";
};

const healthStatus = (
  checks: readonly AdapterHealthCheck[],
): AdapterHealth["status"] =>
  checks.some((check) => check.status === "fail")
    ? "unhealthy"
    : checks.some((check) => check.status === "warn")
      ? "degraded"
      : "healthy";

const errnoCode = (error: unknown): string | undefined =>
  error instanceof Error && "code" in error
    ? String(error.code)
    : undefined;

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (errnoCode(error) === "ENOENT") {
      return false;
    }
    throw error;
  }
};

const escapedPattern = (value: string): string =>
  value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const sectionLines = (
  output: string,
  heading: string,
): readonly string[] => {
  const lines = output.split(/\r?\n/u);
  const start = lines.findIndex(
    (line) => line.trim() === heading,
  );
  if (start === -1) {
    return [];
  }
  const selected: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S.*:\s*$/u.test(line)) {
      break;
    }
    selected.push(line);
  }
  return selected;
};

interface CopilotRegistrationStatus {
  readonly marketplaceRegistered: boolean;
  readonly pluginEnabled: boolean;
  readonly pluginInstalled: boolean;
  readonly registrationError?: string;
}

const stateWith = (
  state: PersistedCopilotAdapterState,
  now: Date,
  update: Partial<
    Omit<PersistedCopilotAdapterState, "schemaVersion" | "updatedAt">
  >,
): PersistedCopilotAdapterState => ({
  ...state,
  ...update,
  schemaVersion: 1,
  updatedAt: now.toISOString(),
});

const assertDataRootMarker = async (
  paths: WindowsProvenLoopPaths,
): Promise<void> => {
  let marker: unknown;
  try {
    marker = JSON.parse(
      await readFile(paths.rootMarker, "utf8"),
    ) as unknown;
  } catch {
    throw new Error(
      `ProvenLoop data root ownership marker is missing or invalid: ${paths.root}.`,
    );
  }
  if (
    !isRecord(marker) ||
    marker.product !== DATA_ROOT_MARKER_PRODUCT ||
    marker.schemaVersion !== 1 ||
    typeof marker.root !== "string" ||
    resolve(marker.root).toLocaleLowerCase("en-US") !==
      resolve(paths.root).toLocaleLowerCase("en-US")
  ) {
    throw new Error(
      `ProvenLoop data root ownership marker is missing or invalid: ${paths.root}.`,
    );
  }
};

export class CopilotCliAdapter
implements AgentAdapter<CopilotEventMappingResult> {
  readonly #cliBinPath: string;
  readonly #commandRunner: CommandRunner;
  readonly #copilotHome: string;
  readonly #environment: Readonly<
    Record<string, string | undefined>
  >;
  readonly #extensionModuleUrl: string;
  readonly #now: () => Date;
  readonly #paths: WindowsProvenLoopPaths;
  readonly #platform: NodeJS.Platform;

  public constructor(options: CopilotCliAdapterOptions) {
    this.#paths = resolveWindowsProvenLoopPaths(options.dataRoot);
    this.#commandRunner =
      options.commandRunner ?? new SpawnCommandRunner();
    this.#environment = options.environment ?? process.env;
    this.#copilotHome = resolve(
      options.copilotHome ??
        this.#environment.COPILOT_HOME ??
        join(homedir(), ".copilot"),
    );
    this.#now = options.now ?? (() => new Date());
    this.#platform = options.platform ?? process.platform;
    this.#extensionModuleUrl =
      options.extensionModuleUrl ??
      new URL("./extension-entry.js", import.meta.url).href;
    this.#cliBinPath =
      options.cliBinPath ??
      fileURLToPath(new URL("../../cli/dist/bin.js", import.meta.url));
  }

  public async capabilities(): Promise<AdapterCapabilityMatrix> {
    const state = await this.#readState();
    const [
      installedVersion,
      registration,
    ] = await Promise.all([
      this.#detectCopilotVersion(),
      this.#registrationStatus(),
    ]);
    const compatibility = compatibilityForVersion(installedVersion);
    const capabilities = PROVENLOOP_CAPABILITIES.map(
      (capability): AdapterCapabilityState => {
        const persisted = state.capabilities[capability];
        const availability = capabilityAvailability(
          capability,
          compatibility,
        );
        const pluginIssue =
          PLUGIN_CAPABILITIES.has(capability) &&
          state.installed &&
          persisted.enabled
            ? registration.registrationError ??
              (
                !registration.pluginInstalled
                  ? "The ProvenLoop Copilot plugin is not installed."
                  : !registration.pluginEnabled
                    ? "The ProvenLoop Copilot plugin is disabled."
                    : undefined
              )
            : undefined;
        const lastError = persisted.lastError ?? pluginIssue;
        return {
          availability,
          capability,
          enabled:
            availability === "available" &&
            persisted.enabled &&
            (
              !PLUGIN_CAPABILITIES.has(capability) ||
              (
                state.installed &&
                registration.pluginInstalled &&
                registration.pluginEnabled &&
                registration.registrationError === undefined
              )
            ),
          ...(lastError === undefined
            ? {}
            : {
                lastError,
              }),
        };
      },
    );
    const capture =
      installedVersion === undefined
        ? undefined
        : getCopilotCaptureCapability(installedVersion);
    return {
      adapter: "copilot-cli",
      capabilities,
      compatibility,
      ...(capture === undefined
        ? {}
        : {
            capture,
          }),
      ...(installedVersion === undefined
        ? {}
        : {
            installedVersion,
          }),
    };
  }

  public async install(): Promise<AdapterOperationResult> {
    await this.#initializeCoreStorage();
    let state = await this.#readState();
    const stateWasInstalled = state.installed;
    const version = await this.#detectCopilotVersion();
    const capability =
      version === undefined
        ? undefined
        : getCopilotCaptureCapability(version);
    state = stateWith(state, this.#now(), {
      ...(version === undefined
        ? {}
        : {
            detectedCopilotVersion: version,
          }),
    });
    if (capability === undefined) {
      const message =
        version === undefined
          ? "GitHub Copilot CLI is unavailable."
          : `GitHub Copilot CLI ${version} is not supported.`;
      state = setPersistedCapability(
        state,
        "capture",
        {
          enabled: false,
          lastError: message,
        },
        this.#now(),
      );
      await this.#writeState(state);
      return {
        message,
        status: "incompatible",
      };
    }

    await this.#writeState(state);
    const before = await this.#requireRegistrationStatus();
    try {
      await this.#writePluginAssets();
      const experimentalSetting = await ensureExperimentalSetting(
        this.#settingsPath(),
        state.experimentalSetting,
      );
      state = stateWith(state, this.#now(), {
        experimentalSetting,
      });
      await this.#writeState(state);
      await this.#ensureMarketplaceRegistered();
      await this.#ensurePluginInstalled();
      await this.#ensurePluginEnabled();
      state = setPersistedCapability(
        state,
        "capture",
        {
          enabled: true,
        },
        this.#now(),
      );
      state = stateWith(state, this.#now(), {
        installed: true,
        marketplaceRegistered: true,
        pluginEnabled: true,
        pluginInstalled: true,
      });
      await this.#writeState(state);
      const changed =
        !before.marketplaceRegistered ||
        !before.pluginInstalled ||
        !before.pluginEnabled ||
        !stateWasInstalled;
      return {
        message: changed
          ? "ProvenLoop Copilot integration installed."
          : "ProvenLoop Copilot integration is already installed.",
        status: changed ? "changed" : "unchanged",
      };
    } catch (error) {
      state = setPersistedCapability(
        state,
        "capture",
        {
          enabled: false,
          lastError: sanitizeDiagnostic(error),
        },
        this.#now(),
      );
      await this.#writeState(state);
      throw error;
    }
  }

  public async status(): Promise<AdapterStatus> {
    const state = await this.#readState();
    const registration = await this.#registrationStatus();
    return {
      capabilities: await this.capabilities(),
      dataRoot: this.#paths.root,
      installed:
        state.installed &&
        registration.marketplaceRegistered &&
        registration.pluginInstalled,
      marketplaceRegistered: registration.marketplaceRegistered,
      pluginEnabled: registration.pluginEnabled,
      pluginInstalled: registration.pluginInstalled,
      ...(registration.registrationError === undefined
        ? {}
        : {
            registrationError: registration.registrationError,
          }),
    };
  }

  public async enable(
    capability: ProvenLoopCapability,
  ): Promise<AdapterOperationResult> {
    let state = await this.#readState();
    const matrix = await this.capabilities();
    const current = matrix.capabilities.find(
      (candidate) => candidate.capability === capability,
    );
    if (current?.availability !== "available") {
      const message =
        `Capability ${capability} is ${current?.availability ?? "unavailable"}.`;
      if (state.installed && await pathExists(this.#paths.root)) {
        await this.#assertOwnedDataRoot();
        state = setPersistedCapability(
          state,
          capability,
          {
            enabled: false,
            lastError: message,
          },
          this.#now(),
        );
        await this.#writeState(state);
      }
      return {
        message,
        status: "incompatible",
      };
    }
    if (!state.installed && PLUGIN_CAPABILITIES.has(capability)) {
      const message =
        `Capability ${capability} requires provenloop install first.`;
      return {
        message,
        status: "incompatible",
      };
    }
    const alreadyEnabled = current.enabled;
    if (capability === "capture") {
      await this.#assertOwnedDataRoot();
      try {
        const experimentalSetting = await ensureExperimentalSetting(
          this.#settingsPath(),
          state.experimentalSetting,
        );
        state = stateWith(state, this.#now(), {
          experimentalSetting,
        });
        await this.#writeState(state);
        await this.#writePluginAssets();
        await this.#ensureMarketplaceRegistered();
        await this.#ensurePluginInstalled();
        await this.#ensurePluginEnabled();
        state = stateWith(state, this.#now(), {
          installed: true,
          marketplaceRegistered: true,
          pluginEnabled: true,
          pluginInstalled: true,
        });
      } catch (error) {
        state = setPersistedCapability(
          state,
          capability,
          {
            enabled: false,
            lastError: sanitizeDiagnostic(error),
          },
          this.#now(),
        );
        await this.#writeState(state);
        throw error;
      }
    }
    state = setPersistedCapability(
      state,
      capability,
      {
        enabled: true,
      },
      this.#now(),
    );
    await this.#writeState(state);
    return {
      message: alreadyEnabled
        ? `Capability ${capability} is already enabled.`
        : `Capability ${capability} enabled.`,
      status: alreadyEnabled ? "unchanged" : "changed",
    };
  }

  public async disable(
    capability: ProvenLoopCapability,
  ): Promise<AdapterOperationResult> {
    if (!await pathExists(this.#paths.root)) {
      return {
        message: `Capability ${capability} is already disabled.`,
        status: "unchanged",
      };
    }
    await this.#assertOwnedDataRoot();
    let state = await this.#readState();
    const alreadyDisabled = !state.capabilities[capability].enabled;
    state = setPersistedCapability(
      state,
      capability,
      {
        enabled: false,
      },
      this.#now(),
    );
    if (capability === "capture") {
      await restoreExperimentalSetting(
        this.#settingsPath(),
        state.experimentalSetting,
      );
      state = clearExperimentalSettingState(state, this.#now());
      const pluginCapabilityEnabled = [...PLUGIN_CAPABILITIES].some(
        (candidate) => state.capabilities[candidate].enabled,
      );
      if (!pluginCapabilityEnabled) {
        await this.#ensurePluginDisabled();
        state = stateWith(state, this.#now(), {
          pluginEnabled: false,
        });
      }
    }
    await this.#writeState(state);
    return {
      message: alreadyDisabled
        ? `Capability ${capability} is already disabled.`
        : `Capability ${capability} disabled.`,
      status: alreadyDisabled ? "unchanged" : "changed",
    };
  }

  public async uninstall(
    options: {
      readonly purge: boolean;
    },
  ): Promise<AdapterOperationResult> {
    let state = await this.#readState();
    const stateWasInstalled = state.installed;
    const dataRootWasPresent = await pathExists(this.#paths.root);
    if (dataRootWasPresent) {
      await this.#assertOwnedDataRoot();
    }
    const registration = await this.#requireRegistrationStatus();
    if (
      !stateWasInstalled &&
      !dataRootWasPresent &&
      !registration.pluginInstalled &&
      !registration.marketplaceRegistered
    ) {
      return {
        message: "ProvenLoop integration is already uninstalled.",
        status: "unchanged",
      };
    }
    if (registration.pluginInstalled) {
      await this.#runRequired(
        [
          "plugin",
          "uninstall",
          COPILOT_PLUGIN_REFERENCE,
        ],
        "plugin uninstall",
      );
    }
    if (registration.marketplaceRegistered) {
      await this.#runRequired(
        [
          "plugin",
          "marketplace",
          "remove",
          COPILOT_MARKETPLACE_NAME,
        ],
        "marketplace removal",
      );
    }
    await restoreExperimentalSetting(
      this.#settingsPath(),
      state.experimentalSetting,
    );
    state = clearExperimentalSettingState(state, this.#now());
    for (const capability of PROVENLOOP_CAPABILITIES) {
      state = setPersistedCapability(
        state,
        capability,
        {
          enabled: false,
        },
        this.#now(),
      );
    }
    state = stateWith(state, this.#now(), {
      installed: false,
      marketplaceRegistered: false,
      pluginEnabled: false,
      pluginInstalled: false,
    });
    await this.#writeState(state);
    await rm(this.#paths.integration, {
      force: true,
      recursive: true,
    });
    if (options.purge) {
      this.#assertSafePurgePath();
      await rm(this.#paths.root, {
        force: true,
        recursive: true,
      });
    }
    const changed =
      registration.pluginInstalled ||
      registration.marketplaceRegistered ||
      stateWasInstalled ||
      (options.purge && dataRootWasPresent);
    return {
      message: options.purge
        ? "ProvenLoop integration uninstalled and local data purged."
        : "ProvenLoop integration uninstalled; local data was preserved.",
      status: changed || options.purge ? "changed" : "unchanged",
    };
  }

  public async registerCaptureExtension(): Promise<AdapterOperationResult> {
    return this.install();
  }

  public async registerContextTools(): Promise<AdapterOperationResult> {
    await this.#initializeCoreStorage();
    const version = await this.#detectCopilotVersion();
    if (
      version === undefined ||
      getCopilotCaptureCapability(version) === undefined
    ) {
      return {
        message: "A supported GitHub Copilot CLI is required.",
        status: "incompatible",
      };
    }
    const before = await this.#requireRegistrationStatus();
    await this.#writePluginAssets();
    await this.#ensureMarketplaceRegistered();
    await this.#ensurePluginInstalled();
    await this.#ensurePluginEnabled();
    const state = stateWith(await this.#readState(), this.#now(), {
      detectedCopilotVersion: version,
      installed: true,
      marketplaceRegistered: true,
      pluginEnabled: true,
      pluginInstalled: true,
    });
    await this.#writeState(state);
    return {
      message: before.pluginInstalled
        ? "ProvenLoop local MCP registration already exists."
        : "ProvenLoop local MCP registration created.",
      status: before.pluginInstalled ? "unchanged" : "changed",
    };
  }

  public normalizeEvent(
    input: unknown,
    context: RuntimeContext,
  ): CopilotEventMappingResult {
    if (!isRecord(input)) {
      return {
        issues: [
          "event must be an object.",
        ],
        status: "malformed",
      };
    }
    const mapper = new CopilotEventMapper({
      adapterVersion: context.adapterVersion,
      copyLimits: {
        maxStringChars: 32_768,
      },
      sessionId: context.sessionId,
    });
    return mapper.map(input);
  }

  public async resolveSession(
    context: RuntimeContext,
  ): Promise<SessionIdentity> {
    const sessionId = context.sessionId.trim();
    if (sessionId.length === 0) {
      throw new Error("Runtime context sessionId must be non-empty.");
    }
    const environment = context.environment ?? this.#environment;
    const internalSessionIds = await readInternalSessionIds(
      this.#paths.internalSessions,
    );
    const internalSession =
      isProvenLoopInternalEnvironment(environment) ||
      internalSessionIds.has(sessionId);
    const rootResult = await this.#runGit(
      context.cwd,
      [
        "rev-parse",
        "--show-toplevel",
      ],
    );
    const repositoryRoot =
      rootResult.exitCode === 0
        ? optionalText(rootResult.stdout)
        : undefined;
    if (repositoryRoot === undefined) {
      return {
        internalSession,
        sessionId,
      };
    }
    const [
      branchResult,
      commitResult,
      commonDirectoryResult,
      remoteResult,
    ] = await Promise.all([
      this.#runGit(repositoryRoot, [
        "branch",
        "--show-current",
      ]),
      this.#runGit(repositoryRoot, [
        "rev-parse",
        "HEAD",
      ]),
      this.#runGit(repositoryRoot, [
        "rev-parse",
        "--git-common-dir",
      ]),
      this.#runGit(repositoryRoot, [
        "config",
        "--get",
        "remote.origin.url",
      ]),
    ]);
    const commonDirectory =
      commonDirectoryResult.exitCode === 0
        ? optionalText(commonDirectoryResult.stdout)
        : undefined;
    const repositoryId =
      commonDirectory === undefined
        ? repositoryRoot
        : resolve(repositoryRoot, commonDirectory);
    const branch =
      branchResult.exitCode === 0
        ? optionalText(branchResult.stdout)
        : undefined;
    const commitSha =
      commitResult.exitCode === 0
        ? optionalText(commitResult.stdout)
        : undefined;
    const repositoryRemote =
      remoteResult.exitCode === 0
        ? optionalText(remoteResult.stdout)
        : undefined;
    return {
      internalSession,
      repositoryId,
      repositoryRoot,
      sessionId,
      worktreePath: repositoryRoot,
      ...(branch === undefined
        ? {}
        : {
            branch,
          }),
      ...(commitSha === undefined
        ? {}
        : {
            commitSha,
          }),
      ...(repositoryRemote === undefined
        ? {}
        : {
            repositoryRemote,
          }),
    };
  }

  public async doctor(): Promise<AdapterHealth> {
    const checks: AdapterHealthCheck[] = [];
    checks.push(this.#nodeCheck());
    checks.push(this.#windowsCheck());
    checks.push(await this.#dataRootCheck());
    checks.push(await this.#sqliteCheck());
    checks.push(await this.#queueCheck());
    checks.push(await this.#workerCheck());
    const status = await this.status();
    checks.push(this.#copilotVersionCheck(status.capabilities));
    checks.push({
      id: "copilot.signin",
      message:
        "Copilot CLI has no non-interactive credential-status command; sign-in availability is unverified.",
      status: "warn",
    });
    checks.push({
      id: "copilot.extension",
      message:
        status.registrationError ??
        (
          status.pluginInstalled
            ? "Copilot Extension plugin registration is present."
            : "Copilot Extension plugin registration is missing."
        ),
      status:
        status.registrationError === undefined &&
        status.pluginInstalled
          ? "pass"
          : "fail",
    });
    checks.push({
      id: "copilot.mcp",
      message:
        status.registrationError ??
        (
          status.pluginInstalled
            ? "Local MCP registration is present in the installed plugin."
            : "Local MCP registration is missing."
        ),
      status:
        status.registrationError === undefined &&
        status.pluginInstalled
          ? "pass"
          : "fail",
    });
    for (const capability of status.capabilities.capabilities) {
      checks.push({
        id: `capability.${capability.capability}`,
        message:
          capability.lastError ??
          `${capability.capability} is ${capability.availability} and ${
            capability.enabled ? "enabled" : "disabled"
          }.`,
        status:
          capability.lastError === undefined
            ? "pass"
            : capability.availability === "available"
              ? "fail"
              : "warn",
      });
    }
    checks.push(await this.#syntheticCaptureCheck());
    return {
      adapter: "copilot-cli",
      checkedAt: this.#now().toISOString(),
      checks,
      status: healthStatus(checks),
    };
  }

  async #readState(): Promise<PersistedCopilotAdapterState> {
    return readCopilotAdapterState(
      this.#paths.adapterState,
      this.#now(),
    );
  }

  async #writeState(
    state: PersistedCopilotAdapterState,
  ): Promise<void> {
    await assertDataRootMarker(this.#paths);
    await writeCopilotAdapterState(this.#paths.adapterState, state);
  }

  async #initializeCoreStorage(): Promise<void> {
    await this.#ensureOwnedDataRoot();
    await Promise.all([
      mkdir(this.#paths.artifacts, {
        recursive: true,
      }),
      mkdir(this.#paths.data, {
        recursive: true,
      }),
      mkdir(this.#paths.evaluation, {
        recursive: true,
      }),
      mkdir(this.#paths.logs, {
        recursive: true,
      }),
      mkdir(this.#paths.queue, {
        recursive: true,
      }),
      mkdir(this.#paths.temporary, {
        recursive: true,
      }),
    ]);
    const queue = new WindowsCaptureQueue(this.#paths.queue);
    await queue.initialize();
    const store = new CanonicalSqliteStore(this.#paths.database);
    store.close();
  }

  async #detectCopilotVersion(): Promise<string | undefined> {
    const result = await this.#runCopilot([
      "--version",
    ]);
    if (result.exitCode !== 0) {
      return undefined;
    }
    const match = /GitHub Copilot CLI\s+([0-9]+\.[0-9]+\.[0-9]+-[0-9]+)/u.exec(
      result.stdout,
    );
    return match?.[1];
  }

  #runCopilot(args: readonly string[]): Promise<CommandResult> {
    return this.#commandRunner.run("copilot", args, {
      environment: {
        ...this.#environment,
        COPILOT_HOME: this.#copilotHome,
      },
    });
  }

  #runGit(
    cwd: string,
    args: readonly string[],
  ): Promise<CommandResult> {
    return this.#commandRunner.run(
      "git",
      [
        "-C",
        cwd,
        ...args,
      ],
      {
        environment: this.#environment,
      },
    );
  }

  async #runRequired(
    args: readonly string[],
    operation: string,
  ): Promise<CommandResult> {
    const result = await this.#runCopilot(args);
    if (result.exitCode !== 0) {
      throw new CopilotCommandError(operation, result);
    }
    return result;
  }

  async #registrationStatus(): Promise<{
    readonly marketplaceRegistered: boolean;
    readonly pluginEnabled: boolean;
    readonly pluginInstalled: boolean;
    readonly registrationError?: string;
  }> {
    const [
      marketplaces,
      plugins,
    ] = await Promise.all([
      this.#runCopilot([
        "plugin",
        "marketplace",
        "list",
      ]),
      this.#runCopilot([
        "plugin",
        "list",
      ]),
    ]);
    const errors = [
      marketplaces.exitCode === 0
        ? undefined
        : `marketplace list: ${
            marketplaces.stderr.trim() ||
            marketplaces.stdout.trim() ||
            `exit ${marketplaces.exitCode}`
          }`,
      plugins.exitCode === 0
        ? undefined
        : `plugin list: ${
            plugins.stderr.trim() ||
            plugins.stdout.trim() ||
            `exit ${plugins.exitCode}`
          }`,
    ].filter((error): error is string => error !== undefined);
    const marketplacePattern = new RegExp(
      `^\\s*[•◆]?\\s*${escapedPattern(
        COPILOT_MARKETPLACE_NAME,
      )}(?:\\s|\\(|$)`,
      "iu",
    );
    const pluginPattern = new RegExp(
      `^\\s*•?\\s*${escapedPattern(
        COPILOT_PLUGIN_NAME,
      )}@${escapedPattern(
        COPILOT_MARKETPLACE_NAME,
      )}(?:\\s|\\(|$)`,
      "iu",
    );
    const marketplaceLine = sectionLines(
      marketplaces.stdout,
      "Registered marketplaces:",
    ).find((line) => marketplacePattern.test(line));
    const pluginLine = plugins.stdout
      .split(/\r?\n/u)
      .find((line) => pluginPattern.test(line));
    const pluginInstalled = pluginLine !== undefined;
    const pluginDisabled =
      pluginLine !== undefined &&
      /\bdisabled\b/iu.test(pluginLine);
    return {
      marketplaceRegistered: marketplaceLine !== undefined,
      pluginEnabled: pluginInstalled && !pluginDisabled,
      pluginInstalled,
      ...(errors.length === 0
        ? {}
        : {
            registrationError: sanitizeDiagnostic(errors.join("; ")),
          }),
    };
  }

  async #requireRegistrationStatus(): Promise<CopilotRegistrationStatus> {
    const status = await this.#registrationStatus();
    if (status.registrationError !== undefined) {
      throw new Error(
        `Copilot registration probe failed: ${status.registrationError}`,
      );
    }
    return status;
  }

  async #ensureMarketplaceRegistered(): Promise<void> {
    const status = await this.#requireRegistrationStatus();
    if (status.marketplaceRegistered) {
      return;
    }
    await this.#runRequired(
      [
        "plugin",
        "marketplace",
        "add",
        this.#marketplaceRoot(),
      ],
      "marketplace registration",
    );
  }

  async #ensurePluginInstalled(): Promise<void> {
    const status = await this.#requireRegistrationStatus();
    if (status.pluginInstalled) {
      return;
    }
    await this.#runRequired(
      [
        "plugin",
        "install",
        COPILOT_PLUGIN_REFERENCE,
      ],
      "plugin installation",
    );
  }

  async #ensurePluginEnabled(): Promise<void> {
    const status = await this.#requireRegistrationStatus();
    if (!status.pluginInstalled || status.pluginEnabled) {
      return;
    }
    await this.#runRequired(
      [
        "plugins",
        "enable",
        COPILOT_PLUGIN_REFERENCE,
        "--plugin",
      ],
      "plugin enable",
    );
  }

  async #ensurePluginDisabled(): Promise<void> {
    const status = await this.#requireRegistrationStatus();
    if (!status.pluginInstalled || !status.pluginEnabled) {
      return;
    }
    await this.#runRequired(
      [
        "plugins",
        "disable",
        COPILOT_PLUGIN_REFERENCE,
        "--plugin",
      ],
      "plugin disable",
    );
  }

  #marketplaceRoot(): string {
    return join(this.#paths.integration, "copilot-marketplace");
  }

  #settingsPath(): string {
    return join(this.#copilotHome, "settings.json");
  }

  async #writePluginAssets(): Promise<void> {
    const marketplaceRoot = this.#marketplaceRoot();
    const pluginRoot = join(
      marketplaceRoot,
      "plugins",
      COPILOT_PLUGIN_NAME,
    );
    const extensionRoot = join(
      pluginRoot,
      "extensions",
      "event-capture",
    );
    await Promise.all([
      mkdir(join(marketplaceRoot, ".github", "plugin"), {
        recursive: true,
      }),
      mkdir(extensionRoot, {
        recursive: true,
      }),
    ]);
    const marketplace = {
      metadata: {
        description: "Local ProvenLoop integration marketplace.",
        version: COPILOT_PLUGIN_VERSION,
      },
      name: COPILOT_MARKETPLACE_NAME,
      owner: {
        name: "ProvenLoop",
      },
      plugins: [
        {
          description: "Local learning infrastructure for Copilot CLI.",
          name: COPILOT_PLUGIN_NAME,
          source: `./plugins/${COPILOT_PLUGIN_NAME}`,
          version: COPILOT_PLUGIN_VERSION,
        },
      ],
    };
    const plugin = {
      description: "Local learning infrastructure for Copilot CLI.",
      extensions: "extensions/",
      mcpServers: ".mcp.json",
      name: COPILOT_PLUGIN_NAME,
      version: COPILOT_PLUGIN_VERSION,
    };
    const mcp = {
      mcpServers: {
        provenloop: {
          args: [
            this.#cliBinPath,
            "mcp",
            "serve",
            "--data-root",
            this.#paths.root,
          ],
          command: process.execPath,
          tools: [
            "*",
          ],
          type: "local",
        },
      },
    };
    const extension = [
      'import { joinSession } from "@github/copilot-sdk/extension";',
      `import { runInstalledCopilotExtension } from ${JSON.stringify(
        this.#extensionModuleUrl,
      )};`,
      "",
      "await runInstalledCopilotExtension({",
      `  dataRoot: ${JSON.stringify(this.#paths.root)},`,
      "  joinSession,",
      "});",
      "",
    ].join("\n");
    await Promise.all([
      writeFile(
        join(
          marketplaceRoot,
          ".github",
          "plugin",
          "marketplace.json",
        ),
        `${JSON.stringify(marketplace, null, 2)}\n`,
        "utf8",
      ),
      writeFile(
        join(pluginRoot, "plugin.json"),
        `${JSON.stringify(plugin, null, 2)}\n`,
        "utf8",
      ),
      writeFile(
        join(pluginRoot, ".mcp.json"),
        `${JSON.stringify(mcp, null, 2)}\n`,
        "utf8",
      ),
      writeFile(
        join(extensionRoot, "extension.mjs"),
        extension,
        "utf8",
      ),
    ]);
  }

  #nodeCheck(): AdapterHealthCheck {
    const [
      majorText,
      minorText,
    ] = process.versions.node.split(".");
    const major = Number(majorText);
    const minor = Number(minorText);
    const supported = major === 22 && minor >= 18;
    return {
      id: "runtime.node",
      message: supported
        ? `Node ${process.versions.node} is supported.`
        : `Node ${process.versions.node} is outside >=22.18.0 <23.`,
      status: supported ? "pass" : "fail",
    };
  }

  #windowsCheck(): AdapterHealthCheck {
    return {
      id: "runtime.windows",
      message:
        this.#platform === "win32"
          ? "Windows runtime is supported."
          : `Platform ${this.#platform} is not supported by the MVP.`,
      status: this.#platform === "win32" ? "pass" : "fail",
    };
  }

  async #dataRootCheck(): Promise<AdapterHealthCheck> {
    const probePath = join(
      this.#paths.root,
      `.doctor-write-${randomUUID()}`,
    );
    try {
      await access(this.#paths.root, constants.W_OK);
      await writeFile(probePath, "ok", "utf8");
      await rm(probePath, {
        force: true,
      });
      const statistics = await statfs(this.#paths.root);
      const freeBytes = statistics.bavail * statistics.bsize;
      return {
        id: "storage.data-root",
        message:
          `Data root is writable with ${Math.floor(
            freeBytes / (1024 ** 3),
          )} GiB free.`,
        status: freeBytes >= 1024 ** 3 ? "pass" : "warn",
      };
    } catch (error) {
      await rm(probePath, {
        force: true,
      }).catch(() => undefined);
      return {
        id: "storage.data-root",
        message:
          errnoCode(error) === "ENOENT"
            ? "Data root is not initialized; run provenloop install."
            : `Data root check failed: ${sanitizeDiagnostic(error)}`,
        status: errnoCode(error) === "ENOENT" ? "warn" : "fail",
      };
    }
  }

  async #sqliteCheck(): Promise<AdapterHealthCheck> {
    try {
      await access(this.#paths.database);
      const store = new CanonicalSqliteStore(this.#paths.database);
      try {
        const health = store.health();
        const healthy =
          health.quickCheck === "ok" &&
          health.userVersion === DEFAULT_SQLITE_MIGRATIONS.length;
        return {
          id: "storage.sqlite",
          message:
            `SQLite quick_check=${health.quickCheck}, migration=${health.userVersion}.`,
          status: healthy ? "pass" : "fail",
        };
      } finally {
        store.close();
      }
    } catch (error) {
      return {
        id: "storage.sqlite",
        message:
          errnoCode(error) === "ENOENT"
            ? "Canonical SQLite database is not initialized."
            : `SQLite check failed: ${sanitizeDiagnostic(error)}`,
        status: errnoCode(error) === "ENOENT" ? "warn" : "fail",
      };
    }
  }

  async #queueCheck(): Promise<AdapterHealthCheck> {
    try {
      await access(this.#paths.queue);
      const queue = new WindowsCaptureQueue(this.#paths.queue);
      await queue.initialize();
      const items = await queue.list();
      const counts = new Map<string, number>();
      for (const item of items) {
        counts.set(item.state, (counts.get(item.state) ?? 0) + 1);
      }
      const pending =
        (counts.get("pending") ?? 0) +
        (counts.get("claimed") ?? 0) +
        (counts.get("retry") ?? 0);
      const deadLetter = counts.get("dead-letter") ?? 0;
      return {
        id: "capture.queue",
        message:
          `Queue backlog=${pending}, retry=${counts.get("retry") ?? 0}, dead-letter=${deadLetter}.`,
        status: deadLetter > 0 ? "warn" : "pass",
      };
    } catch (error) {
      return {
        id: "capture.queue",
        message:
          errnoCode(error) === "ENOENT"
            ? "Capture queue is not initialized."
            : `Capture queue check failed: ${sanitizeDiagnostic(error)}`,
        status: errnoCode(error) === "ENOENT" ? "warn" : "fail",
      };
    }
  }

  async #workerCheck(): Promise<AdapterHealthCheck> {
    const lease = await new WindowsNamedPipeLeaseProvider(
      "capture-worker",
    ).tryAcquire();
    if (lease === undefined) {
      return {
        id: "worker.lease",
        message: "Capture worker lease is active.",
        status: "pass",
      };
    }
    await lease.release();
    try {
      const parsed = JSON.parse(
        await readFile(this.#paths.heartbeat, "utf8"),
      ) as unknown;
      if (
        !isRecord(parsed) ||
        typeof parsed.timestamp !== "string" ||
        Number.isNaN(Date.parse(parsed.timestamp))
      ) {
        throw new Error("Worker heartbeat is malformed.");
      }
      const ageMs =
        this.#now().getTime() - Date.parse(parsed.timestamp);
      return {
        id: "worker.lease",
        message: `Capture worker is idle; last heartbeat was ${Math.max(
          0,
          Math.round(ageMs / 1000),
        )} seconds ago.`,
        status: ageMs <= 120_000 ? "pass" : "warn",
      };
    } catch (error) {
      return {
        id: "worker.lease",
        message:
          errnoCode(error) === "ENOENT"
            ? "Capture worker is idle and has not written a heartbeat."
            : `Worker heartbeat check failed: ${sanitizeDiagnostic(error)}`,
        status: errnoCode(error) === "ENOENT" ? "warn" : "fail",
      };
    }
  }

  #copilotVersionCheck(
    matrix: AdapterCapabilityMatrix,
  ): AdapterHealthCheck {
    return {
      id: "copilot.version",
      message:
        matrix.installedVersion === undefined
          ? "GitHub Copilot CLI is unavailable."
          : matrix.compatibility === "supported"
            ? `GitHub Copilot CLI ${matrix.installedVersion} is supported.`
            : `GitHub Copilot CLI ${matrix.installedVersion} is incompatible.`,
      status:
        matrix.compatibility === "supported"
          ? "pass"
          : matrix.compatibility === "unavailable"
            ? "warn"
            : "fail",
    };
  }

  async #syntheticCaptureCheck(): Promise<AdapterHealthCheck> {
    const root = join(
      this.#paths.temporary,
      `doctor-${randomUUID()}`,
    );
    const queueRoot = join(root, "queue");
    const databasePath = join(root, "doctor.db");
    const secret = "ghp_1234567890abcdefghijklmnopqrst";
    let store: CanonicalSqliteStore | undefined;
    try {
      const queue = new WindowsCaptureQueue(queueRoot, {
        idGenerator: () => "doctor-event",
      });
      await queue.initialize();
      const item = await queue.enqueue({
        adapter: "copilot-cli",
        adapterVersion: "1.0.82-0",
        content: {
          message: secret,
        },
        eventType: "prompt.submitted",
        sessionId: "provenloop-doctor",
        sourceEventId: "synthetic-event",
        timestamp: this.#now().toISOString(),
        trust: "user",
      });
      store = new CanonicalSqliteStore(databasePath);
      const result = store.ingestQueueItem(item);
      const record = store.rawEvent(item.envelope.deduplicationKey);
      const persisted = JSON.stringify(record);
      if (
        result.status !== "stored" ||
        record === undefined ||
        persisted.includes(secret)
      ) {
        throw new Error(
          "Synthetic event did not pass queue, redaction, and canonical storage.",
        );
      }
      return {
        id: "capture.synthetic",
        message:
          "Synthetic capture passed queue, redaction, and canonical SQLite.",
        status: "pass",
      };
    } catch (error) {
      return {
        id: "capture.synthetic",
        message: `Synthetic capture failed: ${sanitizeDiagnostic(error)}`,
        status: "fail",
      };
    } finally {
      store?.close();
      await rm(root, {
        force: true,
        recursive: true,
      });
    }
  }

  async #ensureOwnedDataRoot(): Promise<void> {
    const rootPresent = await pathExists(this.#paths.root);
    const markerPresent = await pathExists(this.#paths.rootMarker);
    if (markerPresent) {
      await assertDataRootMarker(this.#paths);
      return;
    }
    if (rootPresent) {
      throw new Error(
        `Refusing to use unowned existing data root ${this.#paths.root}.`,
      );
    } else {
      await mkdir(this.#paths.root, {
        recursive: true,
      });
    }
    await writeFile(
      this.#paths.rootMarker,
      `${JSON.stringify({
        product: DATA_ROOT_MARKER_PRODUCT,
        root: this.#paths.root,
        schemaVersion: 1,
      }, null, 2)}\n`,
      "utf8",
    );
  }

  async #assertOwnedDataRoot(): Promise<void> {
    await assertDataRootMarker(this.#paths);
    if (!await pathExists(this.#paths.adapterState)) {
      throw new Error(
        `ProvenLoop adapter state is missing from ${this.#paths.root}.`,
      );
    }
    await this.#readState();
    this.#assertSafePurgePath();
  }

  #assertSafePurgePath(): void {
    const root = resolve(this.#paths.root);
    const volumeRoot = parsePath(root).root;
    const normalizedRoot = root.toLocaleLowerCase("en-US");
    if (
      normalizedRoot === volumeRoot.toLocaleLowerCase("en-US") ||
      normalizedRoot ===
        resolve(homedir()).toLocaleLowerCase("en-US") ||
      normalizedRoot ===
        resolve(process.cwd()).toLocaleLowerCase("en-US")
    ) {
      throw new Error(`Refusing to purge unsafe data root ${root}.`);
    }
  }
}

export const registerInternalCopilotSession = async (
  dataRoot: string,
  sessionId: string,
): Promise<void> => {
  const normalized = sessionId.trim();
  if (normalized.length === 0) {
    throw new Error("Internal Copilot session ID must be non-empty.");
  }
  const paths = resolveWindowsProvenLoopPaths(dataRoot);
  await assertDataRootMarker(paths);
  const state = await readCopilotAdapterState(
    paths.adapterState,
    new Date(),
  );
  if (!state.installed) {
    throw new Error(
      "Internal Copilot sessions can only be registered after installation.",
    );
  }
  await writeInternalSessionId(paths.internalSessions, normalized);
};

export const unregisterInternalCopilotSession = async (
  dataRoot: string,
  sessionId: string,
): Promise<void> => {
  const paths = resolveWindowsProvenLoopPaths(dataRoot);
  await assertDataRootMarker(paths);
  await removeInternalSessionId(
    paths.internalSessions,
    sessionId.trim(),
  );
};
