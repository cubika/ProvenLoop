import { CopilotLearningProvider, readCopilotAdapterState } from "@provenloop/copilot-adapter";
import type { LearningToolContract } from "@provenloop/contracts";
import { LearningCoordinator } from "@provenloop/host";
import { resolveWindowsProvenLoopPaths, resolveWindowsProvenLoopLeaseName, WindowsNamedPipeLeaseProvider } from "@provenloop/platform-windows";
import { CanonicalSqliteStore } from "@provenloop/storage-sqlite";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { KnowledgeProjectionManager, SqliteFtsKnowledgeBackend } from "@provenloop/retrieval";

export async function runLearningOnce(options: { readonly dataRoot: string; readonly contracts: readonly LearningToolContract[]; readonly signal?: AbortSignal }) {
  const paths = resolveWindowsProvenLoopPaths(options.dataRoot);
  const enabled = async (): Promise<boolean> => {
    const state = await readCopilotAdapterState(paths.adapterState, new Date());
    return !options.signal?.aborted && state.installed && state.automaticLearning?.enabled === true && state.capabilities.capture.enabled
      && state.capabilities.worker.enabled && state.capabilities.correction_learning.enabled;
  };
  if (!await enabled()) return { status: "disabled" as const };
  const store = new CanonicalSqliteStore(paths.database);
  try {
    const result = await new LearningCoordinator({ store, enabled,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      provider: new CopilotLearningProvider({ temporaryRoot: join(paths.root, "temp"), enabled }),
      lease: new WindowsNamedPipeLeaseProvider(await resolveWindowsProvenLoopLeaseName(paths.root, "learning-inference")),
      contracts: () => options.contracts,
    }).run();
    if (result.status === "evaluated" && (result.qualified ?? 0) > 0) {
      await writeFile(paths.projectionDirty, JSON.stringify({ schemaVersion: 1, markedAt: new Date().toISOString() }) + "\n", "utf8");
      const projectionLease = await new WindowsNamedPipeLeaseProvider(
        await resolveWindowsProvenLoopLeaseName(paths.root, "knowledge-projection"),
      ).tryAcquire();
      if (projectionLease) {
        let backend: SqliteFtsKnowledgeBackend | undefined;
        try {
          if (await enabled() && !store.hasActiveDeletion()) {
            backend = new SqliteFtsKnowledgeBackend(paths.knowledgeDatabase);
            await new KnowledgeProjectionManager({ store, backend }).rebuild();
          }
        } finally {
          await backend?.closeAsync();
          await projectionLease.release();
        }
      }
    }
    const learned = store.pendingLearningActivationIds();
    return { ...result, learned };
  } finally { store.close(); }
}

export async function notifyLearningActivation(dataRoot: string, ids: readonly string[], log: (message: string) => Promise<void>): Promise<boolean> {
  const paths = resolveWindowsProvenLoopPaths(dataRoot);
  const lease = await new WindowsNamedPipeLeaseProvider(await resolveWindowsProvenLoopLeaseName(paths.root, "knowledge-projection")).tryAcquire();
  if (!lease) return false;
  let store: CanonicalSqliteStore | undefined;
  const claimed: string[] = [];
  try {
    store = new CanonicalSqliteStore(paths.database);
    const state = await readCopilotAdapterState(paths.adapterState, new Date());
    if (!state.automaticLearning?.enabled || !state.automaticLearning.notificationsEnabled || !state.capabilities.correction_learning.enabled || store.hasActiveDeletion()) return false;
    for (const id of ids) {
      if (store.claimLearningActivationNotice(id)) claimed.push(id);
      if (claimed.length >= 3) break;
    }
    if (claimed.length === 0) return false;
    const controls = claimed.map((id) => {
      const rule = store?.knowledgeCandidates([id])[0];
      const rootOption = `--data-root "${dataRoot}"`;
      return `${rule?.content ?? id} Source: provenloop knowledge show ${id} ${rootOption}. Undo after review: provenloop knowledge revoke ${id} --expect <review-digest> --confirm ${rootOption}. Delete: provenloop forget ${id} ${rootOption}.`;
    });
    await log(`ProvenLoop learned ${claimed.length} verified tool-invocation rule(s). ${controls.join("\n")}`);
    return true;
  } catch (error) {
    for (const id of claimed) store?.releaseLearningActivationNotice(id);
    throw error;
  } finally { store?.close(); await lease.release(); }
}
