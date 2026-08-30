import { resolve } from "node:path";

export interface WindowsProvenLoopPaths {
  readonly adapterState: string;
  readonly artifacts: string;
  readonly data: string;
  readonly database: string;
  readonly evaluation: string;
  readonly heartbeat: string;
  readonly integration: string;
  readonly internalSessions: string;
  readonly logs: string;
  readonly queue: string;
  readonly root: string;
  readonly rootMarker: string;
  readonly temporary: string;
}

export class LocalAppDataUnavailableError extends Error {
  public override readonly name = "LocalAppDataUnavailableError";

  public constructor() {
    super("LOCALAPPDATA is required to resolve the ProvenLoop data root.");
  }
}

export const resolveWindowsProvenLoopDataRoot = (
  environment: Readonly<Record<string, string | undefined>> =
    process.env,
): string => {
  const localAppData = environment.LOCALAPPDATA?.trim();
  if (!localAppData) {
    throw new LocalAppDataUnavailableError();
  }
  return resolve(localAppData, "ProvenLoop");
};

export const resolveWindowsProvenLoopPaths = (
  root: string,
): WindowsProvenLoopPaths => {
  const resolvedRoot = resolve(root);
  const data = resolve(resolvedRoot, "data");
  const integration = resolve(resolvedRoot, "integration");
  return {
    adapterState: resolve(data, "adapter-state.json"),
    artifacts: resolve(resolvedRoot, "artifacts"),
    data,
    database: resolve(data, "provenloop.db"),
    evaluation: resolve(resolvedRoot, "evaluation"),
    heartbeat: resolve(data, "worker-heartbeat.json"),
    integration,
    internalSessions: resolve(data, "internal-sessions"),
    logs: resolve(resolvedRoot, "logs"),
    queue: resolve(resolvedRoot, "queue"),
    root: resolvedRoot,
    rootMarker: resolve(resolvedRoot, ".provenloop-root.json"),
    temporary: resolve(resolvedRoot, "temp"),
  };
};
