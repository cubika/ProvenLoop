import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  captureQueueItemSchema,
} from "@provenloop/contracts";
import { createCaptureDeduplicationKey } from "@provenloop/domain";
import {
  CaptureWorker,
  CaptureWorkerCircuitBreaker,
} from "@provenloop/host";
import {
  WindowsCaptureQueue,
  WindowsNamedPipeLeaseProvider,
} from "@provenloop/platform-windows";
import {
  CanonicalSqliteStore,
  DEFAULT_SQLITE_MIGRATIONS,
} from "@provenloop/storage-sqlite";

const temporaryDirectories: string[] = [];
const timestamp = "2026-08-29T00:00:00.000Z";

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(
    join(tmpdir(), "provenloop-storage-worker-test-"),
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

const captureInput = (
  sourceEventId: string,
  eventType = "prompt.submitted",
) => ({
  adapter: "copilot-cli",
  adapterVersion: "1.0.82-0",
  content: {
    message: "hello",
  },
  eventType,
  sessionId: "session-1",
  sourceEventId,
  timestamp,
  trust: "user" as const,
});

const createQueue = async (
  root: string,
): Promise<WindowsCaptureQueue> => {
  let sequence = 0;
  const queue = new WindowsCaptureQueue(root, {
    idGenerator: () => `queue-${sequence += 1}`,
    retryBaseDelayMs: 1,
  });
  await queue.initialize();
  return queue;
};

describe("canonical SQLite storage", () => {
  it("enables WAL, busy timeout, migrations, and persistent raw events", async () => {
    const root = await createTemporaryDirectory();
    const databasePath = join(root, "provenloop.db");
    const queue = await createQueue(join(root, "queue"));
    const queued = await queue.enqueue(
      captureInput("event-1"),
      {
        environment: {},
      },
    );
    const store = new CanonicalSqliteStore(databasePath, {
      busyTimeoutMs: 2_500,
      now: () => new Date("2026-08-29T00:00:01.000Z"),
    });

    expect(store.health()).toEqual({
      busyTimeoutMs: 2_500,
      journalMode: "wal",
      quickCheck: "ok",
      userVersion: 1,
    });
    const result = store.ingestQueueItem(queued);
    expect(result.status).toBe("stored");
    const deduplicationKey = createCaptureDeduplicationKey(
      captureInput("event-1"),
    );
    expect(store.rawEvent(deduplicationKey)).toMatchObject({
      deliveryCount: 1,
      eventType: "prompt.submitted",
      parseStatus: "supported",
      sourceEventId: "event-1",
    });
    store.close();

    const reopened = new CanonicalSqliteStore(databasePath);
    expect(reopened.rawEvent(deduplicationKey)).toMatchObject({
      deliveryCount: 1,
    });
    reopened.close();
  });

  it("runs a second redaction pass before canonical persistence", async () => {
    const root = await createTemporaryDirectory();
    const queue = await createQueue(join(root, "queue"));
    const queued = await queue.enqueue(
      captureInput("event-secret"),
      {
        environment: {},
      },
    );
    const secret = "ghp_1234567890abcdefghijklmnopqrst";
    const unsafeItem = captureQueueItemSchema.parse({
      ...queued,
      envelope: {
        ...queued.envelope,
        content: {
          message: secret,
        },
        event: {
          ...queued.envelope.event,
          redactedArguments: {
            [secret]: "value",
          },
        },
        redaction: {
          ...queued.envelope.redaction,
          appliedRules: [
            secret,
          ],
          redactedPaths: [
            `event.${secret}`,
          ],
        },
      },
    });
    const store = new CanonicalSqliteStore(
      join(root, "provenloop.db"),
    );

    const result = store.ingestQueueItem(unsafeItem);
    const record = store.rawEvent(result.deduplicationKey);

    expect(result.status).toBe("stored");
    expect(JSON.stringify(record)).not.toContain(secret);
    expect(record?.envelope.content?.message).toContain(
      "[REDACTED]",
    );
    expect(record?.envelope.event.redactedArguments).toMatchObject({
      "[REDACTED_KEY]": "value",
    });
    store.close();
  });

  it("rolls back a failed migration without advancing user_version", async () => {
    const root = await createTemporaryDirectory();
    const databasePath = join(root, "provenloop.db");
    const initial = new CanonicalSqliteStore(databasePath);
    initial.close();

    expect(() =>
      new CanonicalSqliteStore(databasePath, {
        migrations: [
          ...DEFAULT_SQLITE_MIGRATIONS,
          {
            version: 2,
            sql: `
              CREATE TABLE migration_probe (
                value TEXT NOT NULL
              ) STRICT;
              INVALID SQL;
            `,
          },
        ],
      }),
    ).toThrow();

    const database = new DatabaseSync(databasePath);
    const version = database
      .prepare("PRAGMA user_version;")
      .get() as Readonly<Record<string, unknown>>;
    const probe = database
      .prepare(
        `SELECT count(*) AS count
           FROM sqlite_master
          WHERE type = 'table'
            AND name = 'migration_probe'`,
      )
      .get() as Readonly<Record<string, unknown>>;
    expect(Number(version.user_version)).toBe(1);
    expect(Number(probe.count)).toBe(0);
    database.close();
  });

  it("rolls back a migration that violates schema postconditions", async () => {
    const root = await createTemporaryDirectory();
    const databasePath = join(root, "provenloop.db");
    const initial = new CanonicalSqliteStore(databasePath);
    initial.close();

    expect(() =>
      new CanonicalSqliteStore(databasePath, {
        migrations: [
          ...DEFAULT_SQLITE_MIGRATIONS,
          {
            version: 2,
            sql: `
              ALTER TABLE raw_events
              ADD COLUMN unexpected TEXT;
            `,
          },
        ],
      }),
    ).toThrow("unexpected column count");

    const database = new DatabaseSync(databasePath);
    const version = database
      .prepare("PRAGMA user_version;")
      .get() as Readonly<Record<string, unknown>>;
    const columns = database
      .prepare("PRAGMA table_info(raw_events);")
      .all() as readonly Readonly<Record<string, unknown>>[];
    expect(Number(version.user_version)).toBe(1);
    expect(
      columns.some((column) => column.name === "unexpected"),
    ).toBe(false);
    database.close();
  });

  it("rejects generated columns hidden from table_info", async () => {
    const root = await createTemporaryDirectory();
    const databasePath = join(root, "provenloop.db");
    const initial = new CanonicalSqliteStore(databasePath);
    initial.close();

    expect(() =>
      new CanonicalSqliteStore(databasePath, {
        migrations: [
          ...DEFAULT_SQLITE_MIGRATIONS,
          {
            version: 2,
            sql: `
              ALTER TABLE raw_events
              ADD COLUMN generated_guard TEXT
              GENERATED ALWAYS AS (
                CASE
                  WHEN event_type = 'prompt.submitted'
                  THEN NULL
                  ELSE 'ok'
                END
              ) VIRTUAL NOT NULL;
            `,
          },
        ],
      }),
    ).toThrow("unexpected column count");

    const database = new DatabaseSync(databasePath);
    const version = database
      .prepare("PRAGMA user_version;")
      .get() as Readonly<Record<string, unknown>>;
    expect(Number(version.user_version)).toBe(1);
    database.close();
  });

  it("upgrades an existing database transactionally", async () => {
    const root = await createTemporaryDirectory();
    const databasePath = join(root, "provenloop.db");
    const initial = new CanonicalSqliteStore(databasePath);
    initial.close();

    const upgraded = new CanonicalSqliteStore(databasePath, {
      migrations: [
        ...DEFAULT_SQLITE_MIGRATIONS,
        {
          version: 2,
          sql: `
            CREATE TABLE recovery_probe (
              value TEXT NOT NULL
            ) STRICT;
          `,
        },
      ],
    });
    expect(upgraded.health().userVersion).toBe(2);
    upgraded.close();

    const database = new DatabaseSync(databasePath);
    const probe = database
      .prepare(
        `SELECT count(*) AS count
           FROM sqlite_master
          WHERE type = 'table'
            AND name = 'recovery_probe'`,
      )
      .get() as Readonly<Record<string, unknown>>;
    expect(Number(probe.count)).toBe(1);
    database.close();
  });

  it("backs up and restores a verified canonical database", async () => {
    const root = await createTemporaryDirectory();
    const databasePath = join(root, "provenloop.db");
    const backupPath = join(root, "backups", "capture.db");
    const queue = await createQueue(join(root, "queue"));
    const first = await queue.enqueue(captureInput("event-1"), {
      environment: {},
    });
    const second = await queue.enqueue(captureInput("event-2"), {
      environment: {},
    });
    const store = new CanonicalSqliteStore(databasePath);
    store.ingestQueueItem(first);
    expect(await store.backupTo(backupPath)).toBeGreaterThan(0);
    store.ingestQueueItem(second);
    store.close();

    expect(
      await CanonicalSqliteStore.restoreFromBackup(
        backupPath,
        databasePath,
      ),
    ).toMatchObject({
      quickCheck: "ok",
      userVersion: 1,
    });
    const restored = new CanonicalSqliteStore(databasePath);
    expect(
      await restored.deduplicationKeys(
        "copilot-cli",
        "1.0.82-0",
        "session-1",
      ),
    ).toEqual(
      new Set([
        createCaptureDeduplicationKey(captureInput("event-1")),
      ]),
    );
    restored.close();
  });

  it("preserves the existing database when backup validation fails", async () => {
    const root = await createTemporaryDirectory();
    const databasePath = join(root, "provenloop.db");
    const invalidBackupPath = join(root, "invalid-backup.db");
    const queue = await createQueue(join(root, "queue"));
    const queued = await queue.enqueue(captureInput("event-1"), {
      environment: {},
    });
    const store = new CanonicalSqliteStore(databasePath);
    store.ingestQueueItem(queued);
    store.close();
    const invalidBackup = new DatabaseSync(invalidBackupPath);
    invalidBackup.exec("PRAGMA user_version = 99;");
    invalidBackup.close();

    await expect(
      CanonicalSqliteStore.restoreFromBackup(
        invalidBackupPath,
        databasePath,
      ),
    ).rejects.toThrow("not the current canonical version");

    const preserved = new CanonicalSqliteStore(databasePath);
    expect(
      preserved.rawEvent(
        createCaptureDeduplicationKey(captureInput("event-1")),
      ),
    ).toBeDefined();
    preserved.close();
  });

  it("rejects a physically valid but non-canonical backup", async () => {
    const root = await createTemporaryDirectory();
    const databasePath = join(root, "provenloop.db");
    const invalidBackupPath = join(root, "invalid-schema.db");
    const queue = await createQueue(join(root, "queue"));
    const queued = await queue.enqueue(captureInput("event-1"), {
      environment: {},
    });
    const store = new CanonicalSqliteStore(databasePath);
    store.ingestQueueItem(queued);
    store.close();
    const invalidBackup = new DatabaseSync(invalidBackupPath);
    invalidBackup.exec(`
      PRAGMA user_version = 1;
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO schema_migrations(version, applied_at)
      VALUES (1, '2026-08-29T00:00:00.000Z');
    `);
    invalidBackup.close();

    await expect(
      CanonicalSqliteStore.restoreFromBackup(
        invalidBackupPath,
        databasePath,
      ),
    ).rejects.toThrow("canonical table");

    const preserved = new CanonicalSqliteStore(databasePath);
    expect(
      preserved.rawEvent(
        createCaptureDeduplicationKey(captureInput("event-1")),
      ),
    ).toBeDefined();
    preserved.close();
  });

  it("rejects an unrelated version-zero SQLite backup", async () => {
    const root = await createTemporaryDirectory();
    const databasePath = join(root, "provenloop.db");
    const unrelatedBackupPath = join(root, "unrelated.db");
    const store = new CanonicalSqliteStore(databasePath);
    store.close();
    const unrelated = new DatabaseSync(unrelatedBackupPath);
    unrelated.exec("CREATE TABLE unrelated(value TEXT);");
    unrelated.close();

    await expect(
      CanonicalSqliteStore.restoreFromBackup(
        unrelatedBackupPath,
        databasePath,
      ),
    ).rejects.toThrow("not the current canonical version");
    const preserved = new CanonicalSqliteStore(databasePath);
    expect(preserved.health()).toMatchObject({
      quickCheck: "ok",
      userVersion: 1,
    });
    preserved.close();
  });

  it("rejects a backup with a weakened partial identity index", async () => {
    const root = await createTemporaryDirectory();
    const databasePath = join(root, "provenloop.db");
    const weakenedBackupPath = join(root, "weakened.db");
    const target = new CanonicalSqliteStore(databasePath);
    target.close();
    const weakened = new CanonicalSqliteStore(weakenedBackupPath);
    weakened.close();
    const database = new DatabaseSync(weakenedBackupPath);
    database.exec(`
      DROP INDEX raw_events_source_identity;
      CREATE UNIQUE INDEX raw_events_source_identity
        ON raw_events(
          adapter,
          adapter_version,
          session_id,
          event_type,
          source_event_id
        )
        WHERE event_type <> 'ignored';
    `);
    database.close();

    await expect(
      CanonicalSqliteStore.restoreFromBackup(
        weakenedBackupPath,
        databasePath,
      ),
    ).rejects.toThrow("does not match the declared schema");
    const preserved = new CanonicalSqliteStore(databasePath);
    preserved.close();
  });

  it("rejects a backup with an undeclared data-changing trigger", async () => {
    const root = await createTemporaryDirectory();
    const databasePath = join(root, "provenloop.db");
    const triggeredBackupPath = join(root, "triggered.db");
    const target = new CanonicalSqliteStore(databasePath);
    target.close();
    const triggered = new CanonicalSqliteStore(
      triggeredBackupPath,
    );
    triggered.close();
    const database = new DatabaseSync(triggeredBackupPath);
    database.exec(`
      CREATE TRIGGER delete_captured_event
      AFTER INSERT ON raw_events
      BEGIN
        DELETE FROM raw_events
        WHERE deduplication_key = NEW.deduplication_key;
      END;
    `);
    database.close();

    await expect(
      CanonicalSqliteStore.restoreFromBackup(
        triggeredBackupPath,
        databasePath,
      ),
    ).rejects.toThrow("undeclared objects");
    const preserved = new CanonicalSqliteStore(databasePath);
    preserved.close();
  });

  it("rejects a backup containing undeclared tables", async () => {
    const root = await createTemporaryDirectory();
    const databasePath = join(root, "provenloop.db");
    const hiddenBackupPath = join(root, "hidden-table.db");
    const target = new CanonicalSqliteStore(databasePath);
    target.close();
    const hidden = new CanonicalSqliteStore(hiddenBackupPath);
    hidden.close();
    const database = new DatabaseSync(hiddenBackupPath);
    database.exec(`
      CREATE TABLE hidden_data (
        value TEXT
      );
    `);
    database.close();

    await expect(
      CanonicalSqliteStore.restoreFromBackup(
        hiddenBackupPath,
        databasePath,
      ),
    ).rejects.toThrow("undeclared objects");
    const preserved = new CanonicalSqliteStore(databasePath);
    preserved.close();
  });

  it("keeps rejected parser errors idempotent across replay", async () => {
    const root = await createTemporaryDirectory();
    const queue = await createQueue(join(root, "queue"));
    const queued = await queue.enqueue(
      captureInput("event-missing-session"),
      {
        environment: {},
      },
    );
    const invalid = captureQueueItemSchema.parse({
      ...queued,
      envelope: {
        ...queued.envelope,
        event: {
          ...queued.envelope.event,
          sessionId: undefined,
        },
      },
    });
    const store = new CanonicalSqliteStore(
      join(root, "provenloop.db"),
    );

    expect(store.ingestQueueItem(invalid).status).toBe("rejected");
    expect(store.ingestQueueItem(invalid).status).toBe("rejected");
    expect(store.parserErrors()).toHaveLength(1);
    store.close();
  });

  it("records unsupported duplicate processing as unsupported", async () => {
    const root = await createTemporaryDirectory();
    const queue = await createQueue(join(root, "queue"));
    const first = await queue.enqueue(
      captureInput("future-event", "future.persisted_event"),
      {
        environment: {},
      },
    );
    const second = captureQueueItemSchema.parse({
      ...first,
      queueItemId: "queue-replay",
    });
    const store = new CanonicalSqliteStore(
      join(root, "provenloop.db"),
    );

    expect(store.ingestQueueItem(first).status).toBe("unsupported");
    expect(store.ingestQueueItem(second).status).toBe("unsupported");
    expect(store.queueProcessing("queue-replay")).toEqual({
      queueItemId: "queue-replay",
      status: "unsupported",
    });
    store.close();
  });

  it("rolls back a failed ingestion transaction completely", async () => {
    const root = await createTemporaryDirectory();
    const databasePath = join(root, "provenloop.db");
    const queue = await createQueue(join(root, "queue"));
    const queued = await queue.enqueue(
      captureInput("event-triggered-failure"),
      {
        environment: {},
      },
    );
    const store = new CanonicalSqliteStore(databasePath, {
      faultInjector: () => {
        throw new Error("simulated ingestion failure");
      },
    });
    const deduplicationKey = createCaptureDeduplicationKey(
      captureInput("event-triggered-failure"),
    );

    expect(() => store.ingestQueueItem(queued)).toThrow(
      "simulated ingestion failure",
    );
    expect(store.rawEvent(deduplicationKey)).toBeUndefined();
    expect(store.queueProcessing(queued.queueItemId)).toBeUndefined();
    store.close();
  });
});

describe("shared capture worker", () => {
  it("stores supported events and acknowledges only after commit", async () => {
    const root = await createTemporaryDirectory();
    const queue = await createQueue(join(root, "queue"));
    await queue.enqueueIfSourceAbsent(captureInput("event-1"), {
      environment: {},
    });
    const store = new CanonicalSqliteStore(
      join(root, "provenloop.db"),
    );
    const worker = new CaptureWorker({
      batchSize: 10,
      lease: new WindowsNamedPipeLeaseProvider(
        `worker-${randomUUID()}`,
      ),
      queue,
      store,
      workerId: "worker-1",
    });

    expect(await worker.runOnce()).toMatchObject({
      status: "completed",
      acknowledged: 1,
      stored: 1,
    });
    expect(await queue.list("acknowledged")).toHaveLength(1);
    expect(
      await store.deduplicationKeys(
        "copilot-cli",
        "1.0.82-0",
        "session-1",
      ),
    ).toHaveLength(1);
    store.close();
  });

  it("replays idempotently when acknowledgement fails after commit", async () => {
    const root = await createTemporaryDirectory();
    let sequence = 0;
    const queue = new WindowsCaptureQueue(join(root, "queue"), {
      idGenerator: () => `queue-${sequence += 1}`,
      maxAttempts: 1,
      retryBaseDelayMs: 1,
    });
    await queue.initialize();
    await queue.enqueueIfSourceAbsent(captureInput("event-1"), {
      environment: {},
    });
    const store = new CanonicalSqliteStore(
      join(root, "provenloop.db"),
    );
    let failAcknowledge = true;
    const flakyQueue = {
      acknowledge: async (
        claim: Parameters<WindowsCaptureQueue["acknowledge"]>[0],
      ) => {
        if (failAcknowledge) {
          failAcknowledge = false;
          throw new Error("simulated acknowledgement failure");
        }
        return queue.acknowledge(claim);
      },
      claimNext: (workerId: string) => queue.claimNext(workerId),
      deadLetter: (
        claim: Parameters<WindowsCaptureQueue["deadLetter"]>[0],
        error: unknown,
      ) => queue.deadLetter(claim, error),
      recoverExpiredClaims: () => queue.recoverExpiredClaims(),
      retry: (
        claim: Parameters<WindowsCaptureQueue["retry"]>[0],
        error: unknown,
      ) => queue.retry(claim, error),
      retryAfterCommit: (
        claim: Parameters<
          WindowsCaptureQueue["retryAfterCommit"]
        >[0],
        error: unknown,
      ) => queue.retryAfterCommit(claim, error),
    };
    const worker = new CaptureWorker({
      batchSize: 1,
      lease: new WindowsNamedPipeLeaseProvider(
        `worker-${randomUUID()}`,
      ),
      queue: flakyQueue,
      store,
      workerId: "worker-1",
    });

    expect(await worker.runOnce()).toMatchObject({
      status: "completed",
      failed: 1,
      retried: 1,
      stored: 1,
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 2);
    });
    expect(await worker.runOnce()).toMatchObject({
      status: "completed",
      acknowledged: 1,
      duplicates: 1,
    });
    const deduplicationKey = createCaptureDeduplicationKey(
      captureInput("event-1"),
    );
    expect(store.rawEvent(deduplicationKey)).toMatchObject({
      deliveryCount: 2,
    });
    store.close();
  });

  it("stores unsupported envelopes and moves them to dead-letter", async () => {
    const root = await createTemporaryDirectory();
    const queue = await createQueue(join(root, "queue"));
    await queue.enqueueIfSourceAbsent(
      captureInput("future-event", "future.persisted_event"),
      {
        environment: {},
      },
    );
    const store = new CanonicalSqliteStore(
      join(root, "provenloop.db"),
    );
    const worker = new CaptureWorker({
      batchSize: 10,
      lease: new WindowsNamedPipeLeaseProvider(
        `worker-${randomUUID()}`,
      ),
      queue,
      store,
      workerId: "worker-1",
    });

    expect(await worker.runOnce()).toMatchObject({
      status: "completed",
      deadLettered: 1,
      unsupported: 1,
    });
    expect(await queue.list("dead-letter")).toHaveLength(1);
    expect(store.parserErrors()).toEqual([
      expect.objectContaining({
        errorKind: "unsupported_event_type",
        queueItemId: "queue-1",
      }),
    ]);
    store.close();
  });

  it("leaves backlog untouched while the consumer is disabled", async () => {
    const root = await createTemporaryDirectory();
    const queue = await createQueue(join(root, "queue"));
    await queue.enqueueIfSourceAbsent(captureInput("event-1"), {
      environment: {},
    });
    const store = new CanonicalSqliteStore(
      join(root, "provenloop.db"),
    );
    const worker = new CaptureWorker({
      batchSize: 10,
      enabled: () => false,
      lease: new WindowsNamedPipeLeaseProvider(
        `worker-${randomUUID()}`,
      ),
      queue,
      store,
      workerId: "worker-1",
    });

    expect(await worker.runOnce()).toEqual({
      status: "disabled",
    });
    expect(await queue.list("pending")).toHaveLength(1);
    expect(
      await store.deduplicationKeys(
        "copilot-cli",
        "1.0.82-0",
        "session-1",
      ),
    ).toHaveLength(0);
    store.close();
  });

  it("stops dequeue when the resource circuit opens", async () => {
    const root = await createTemporaryDirectory();
    const queue = await createQueue(join(root, "queue"));
    await queue.enqueueIfSourceAbsent(captureInput("event-1"), {
      environment: {},
    });
    await queue.enqueueIfSourceAbsent(captureInput("event-2"), {
      environment: {},
    });
    const store = new CanonicalSqliteStore(
      join(root, "provenloop.db"),
    );
    const breaker = new CaptureWorkerCircuitBreaker({
      maxConsecutiveProviderErrors: 3,
      maxCpuPercent: 80,
      maxMemoryBytes: 1_000_000,
      maxQueueDepth: 100,
      minFreeDiskBytes: 1_000,
    });
    let admissionCalls = 0;
    const worker = new CaptureWorker({
      admission: () => {
        admissionCalls += 1;
        return breaker.evaluate({
          consecutiveProviderErrors: 0,
          cpuPercent: admissionCalls >= 3 ? 90 : 10,
          freeDiskBytes: 10_000,
          memoryBytes: 100,
          queueDepth: 2,
        });
      },
      batchSize: 10,
      lease: new WindowsNamedPipeLeaseProvider(
        `worker-${randomUUID()}`,
      ),
      queue,
      store,
      workerId: "worker-1",
    });

    expect(await worker.runOnce()).toMatchObject({
      status: "completed",
      acknowledged: 1,
      circuitOpenReasons: [
        "cpu",
      ],
      stored: 1,
    });
    expect(await queue.list("pending")).toHaveLength(1);
    store.close();
  });

  it("drains one item per run under queue-only pressure", async () => {
    const root = await createTemporaryDirectory();
    const queue = await createQueue(join(root, "queue"));
    await queue.enqueueIfSourceAbsent(captureInput("event-1"), {
      environment: {},
    });
    await queue.enqueueIfSourceAbsent(captureInput("event-2"), {
      environment: {},
    });
    const store = new CanonicalSqliteStore(
      join(root, "provenloop.db"),
    );
    const breaker = new CaptureWorkerCircuitBreaker({
      maxConsecutiveProviderErrors: 3,
      maxCpuPercent: 80,
      maxMemoryBytes: 1_000_000,
      maxQueueDepth: 2,
      minFreeDiskBytes: 1_000,
    });
    const worker = new CaptureWorker({
      admission: () =>
        breaker.evaluate({
          consecutiveProviderErrors: 0,
          cpuPercent: 10,
          freeDiskBytes: 10_000,
          memoryBytes: 100,
          queueDepth: 2,
        }),
      batchSize: 10,
      lease: new WindowsNamedPipeLeaseProvider(
        `worker-${randomUUID()}`,
      ),
      queue,
      store,
      workerId: "worker-1",
    });

    expect(await worker.runOnce()).toMatchObject({
      status: "completed",
      acknowledged: 1,
      circuitOpenReasons: [
        "queue",
      ],
    });
    expect(await queue.list("pending")).toHaveLength(1);
    expect(await worker.runOnce()).toMatchObject({
      status: "completed",
      acknowledged: 1,
    });
    expect(await queue.list("pending")).toHaveLength(0);
    store.close();
  });

  it("allows only one named-pipe worker lease at a time", async () => {
    const name = `worker-${randomUUID()}`;
    const firstProvider = new WindowsNamedPipeLeaseProvider(name);
    const secondProvider = new WindowsNamedPipeLeaseProvider(name);
    const first = await firstProvider.tryAcquire();

    expect(first).toBeDefined();
    expect(await secondProvider.tryAcquire()).toBeUndefined();
    await first?.release();
    const second = await secondProvider.tryAcquire();
    expect(second).toBeDefined();
    await second?.release();
  });
});
