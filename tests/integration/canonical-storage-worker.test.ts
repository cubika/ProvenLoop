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
import { CaptureWorker } from "@provenloop/host";
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
      migrations: [
        ...DEFAULT_SQLITE_MIGRATIONS,
        {
          version: 2,
          sql: `
            CREATE TRIGGER reject_raw_event
            BEFORE INSERT ON raw_events
            BEGIN
              SELECT RAISE(ABORT, 'simulated ingestion failure');
            END;
          `,
        },
      ],
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
