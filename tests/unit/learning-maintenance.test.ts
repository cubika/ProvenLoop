import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDefaultCopilotAdapterState,
  writeCopilotAdapterState,
} from "@provenloop/copilot-adapter";
import {
  beginExtensionShutdown,
  resolveWindowsProvenLoopLeaseName,
  resolveWindowsProvenLoopPaths,
  WindowsNamedPipeLeaseProvider,
} from "@provenloop/platform-windows";
import { CanonicalSqliteStore, DEFAULT_SQLITE_MIGRATIONS } from "@provenloop/storage-sqlite";

import { runLearningOnce } from "../../packages/cli/src/run-learning.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

const seedLegacyLearningInstallation = async () => {
  const root = await mkdtemp(join(tmpdir(), "provenloop-learning-maintenance-"));
  roots.push(root);
  const paths = resolveWindowsProvenLoopPaths(root);
  await mkdir(paths.data);
  await writeFile(paths.rootMarker, JSON.stringify({ product: "ProvenLoop", schemaVersion: 1, root }));
  const now = new Date();
  const state = createDefaultCopilotAdapterState(now);
  await writeCopilotAdapterState(paths.adapterState, {
    ...state,
    installed: true,
    automaticLearning: {
      consentedAt: now.toISOString(), disclosureVersion: 1, enabled: true, notificationsEnabled: true,
    },
    capabilities: {
      ...state.capabilities,
      capture: { enabled: true },
      worker: { enabled: true },
      correction_learning: { enabled: true },
    },
  });
  new CanonicalSqliteStore(paths.database, { migrations: DEFAULT_SQLITE_MIGRATIONS.slice(0, -1) }).close();
  return paths;
};

describe("learning database lifetime during maintenance", () => {
  it("does not open a legacy database while the inference lease is held and releases the lease after an open failure", async () => {
    const paths = await seedLegacyLearningInstallation();
    const inference = new WindowsNamedPipeLeaseProvider(
      await resolveWindowsProvenLoopLeaseName(paths.root, "learning-inference"),
    );
    const held = await inference.tryAcquire();
    try {
      expect(held).toBeDefined();
      await expect(runLearningOnce({ dataRoot: paths.root, contracts: [] }))
        .resolves.toMatchObject({ status: "busy" });
      expect(CanonicalSqliteStore.databaseVersion(paths.database))
        .toBe(DEFAULT_SQLITE_MIGRATIONS.length - 1);
    } finally {
      await held?.release();
    }
    await expect(runLearningOnce({ dataRoot: paths.root, contracts: [] }))
      .rejects.toThrow("maintenance upgrade");
    const released = await inference.tryAcquire();
    try {
      expect(released).toBeDefined();
    } finally {
      await released?.release();
    }
    new CanonicalSqliteStore(paths.database, { allowSchemaMigration: true }).close();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(runLearningOnce({ dataRoot: paths.root, contracts: [] }))
        .resolves.toMatchObject({ status: "idle", learned: [] });
    }
  });

  it("does not open the database after maintenance requests shutdown even before it owns the inference lease", async () => {
    const paths = await seedLegacyLearningInstallation();
    const shutdown = await beginExtensionShutdown(paths.root);
    try {
      await expect(runLearningOnce({ dataRoot: paths.root, contracts: [] }))
        .resolves.toMatchObject({ status: "disabled" });
      expect(CanonicalSqliteStore.databaseVersion(paths.database))
        .toBe(DEFAULT_SQLITE_MIGRATIONS.length - 1);
    } finally {
      await shutdown.cancel();
    }
    await expect(runLearningOnce({ dataRoot: paths.root, contracts: [] }))
      .rejects.toThrow("maintenance upgrade");
  });
});
