import { randomUUID } from "node:crypto";
import {
  mkdir,
  unlink,
} from "node:fs/promises";
import { dirname } from "node:path";
import {
  backup,
  DatabaseSync,
} from "node:sqlite";

import {
  captureQueueItemSchema,
  classifyRawEvent,
  type CaptureEnvelope,
  type CaptureQueueItem,
} from "@provenloop/contracts";
import {
  createCaptureDeduplicationKey,
  redactCaptureEnvelopeForPersistence,
  sanitizeDiagnostic,
} from "@provenloop/domain";

export interface SqliteMigration {
  readonly sql: string;
  readonly version: number;
}

export interface CanonicalSqliteStoreOptions {
  readonly busyTimeoutMs?: number;
  readonly faultInjector?: (
    stage: "after_raw_event_insert",
  ) => void;
  readonly migrations?: readonly SqliteMigration[];
  readonly now?: () => Date;
}

export interface CanonicalStoreHealth {
  readonly busyTimeoutMs: number;
  readonly journalMode: string;
  readonly quickCheck: string;
  readonly userVersion: number;
}

export type CanonicalIngestResult =
  | {
      readonly deduplicationKey: string;
      readonly status: "duplicate" | "stored";
    }
  | {
      readonly deduplicationKey: string;
      readonly reason: string;
      readonly status: "rejected" | "unsupported";
    };

export interface CanonicalRawEventRecord {
  readonly adapter: string;
  readonly adapterVersion: string;
  readonly deduplicationKey: string;
  readonly deliveryCount: number;
  readonly envelope: CaptureEnvelope;
  readonly eventId: string;
  readonly eventType: string;
  readonly parseStatus: string;
  readonly sessionId?: string;
  readonly sourceEventId: string;
}

export interface CanonicalParserErrorRecord {
  readonly errorKind: string;
  readonly message: string;
  readonly queueItemId: string;
}

export interface QueueProcessingRecord {
  readonly queueItemId: string;
  readonly status: string;
}

export const DEFAULT_SQLITE_MIGRATIONS = [
  {
    version: 1,
    sql: `
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE raw_events (
        deduplication_key TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        adapter TEXT NOT NULL,
        adapter_version TEXT NOT NULL,
        event_type TEXT NOT NULL,
        session_id TEXT,
        repo_id TEXT,
        branch TEXT,
        worktree TEXT,
        commit_sha TEXT,
        event_timestamp TEXT NOT NULL,
        trust TEXT NOT NULL,
        content_digest TEXT,
        result_digest TEXT,
        redaction_rule_version INTEGER NOT NULL,
        parse_status TEXT NOT NULL,
        safe_envelope_json TEXT NOT NULL,
        storage_redaction_applied INTEGER NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        delivery_count INTEGER NOT NULL
      ) STRICT;

      CREATE UNIQUE INDEX raw_events_source_identity
        ON raw_events(
          adapter,
          adapter_version,
          session_id,
          event_type,
          source_event_id
        );

      CREATE TABLE parser_errors (
        parser_error_id INTEGER PRIMARY KEY,
        queue_item_id TEXT NOT NULL,
        deduplication_key TEXT,
        error_kind TEXT NOT NULL,
        message TEXT NOT NULL,
        safe_envelope_json TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(queue_item_id, error_kind)
      ) STRICT;

      CREATE TABLE identities (
        identity_id TEXT PRIMARY KEY,
        identity_type TEXT NOT NULL,
        canonical_value TEXT NOT NULL,
        source_digest TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE queue_processing (
        queue_item_id TEXT PRIMARY KEY,
        deduplication_key TEXT,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL,
        failure_count INTEGER NOT NULL,
        last_error TEXT,
        processed_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE work_episodes (
        episode_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        body_json TEXT NOT NULL,
        source_digest TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE evidence_links (
        link_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        body_json TEXT NOT NULL,
        source_digest TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE process_claims (
        claim_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        body_json TEXT NOT NULL,
        source_digest TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE feedback_events (
        feedback_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        body_json TEXT NOT NULL,
        source_digest TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE deletion_operations (
        deletion_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        body_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE metrics (
        metric_id INTEGER PRIMARY KEY,
        metric_name TEXT NOT NULL,
        metric_value REAL NOT NULL,
        dimensions_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE evaluation_runs (
        run_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        status TEXT NOT NULL,
        report_digest TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      ) STRICT;
    `,
  },
] as const satisfies readonly SqliteMigration[];

export class UnsupportedDatabaseVersionError extends Error {
  public override readonly name = "UnsupportedDatabaseVersionError";

  public constructor(version: number, latestVersion: number) {
    super(
      `Database version ${version} is newer than supported version ${latestVersion}.`,
    );
  }
}

export class InvalidMigrationPlanError extends Error {
  public override readonly name = "InvalidMigrationPlanError";

  public constructor() {
    super("SQLite migrations must be contiguous and start at version 1.");
  }
}

export class InvalidCanonicalSchemaError extends Error {
  public override readonly name = "InvalidCanonicalSchemaError";

  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

const asNumber = (value: unknown): number => {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  return Number(value);
};

const optionalText = (value: string | undefined): string | null =>
  value ?? null;

const firstColumn = (
  row: Readonly<Record<string, unknown>>,
): unknown => Object.values(row)[0];

const sqliteIdentifier = (value: string): string =>
  `"${value.replaceAll("\"", "\"\"")}"`;

const normalizeSchemaSql = (value: unknown): string =>
  String(value).replaceAll(/\s+/gu, " ").trim();

const createExpectedCanonicalObjectSql = (
  migrations: readonly SqliteMigration[],
): ReadonlyMap<
  string,
  string
> => {
  const database = new DatabaseSync(":memory:");
  try {
    for (const migration of migrations) {
      database.exec(migration.sql);
    }
    const rows = database
      .prepare(
        `SELECT name, sql, type
           FROM sqlite_master
          WHERE sql IS NOT NULL
            AND name NOT LIKE 'sqlite_%'`,
      )
      .all() as readonly Readonly<Record<string, unknown>>[];
    return new Map(
      rows.map((row) => [
        `${String(row.type)}:${String(row.name)}`,
        normalizeSchemaSql(row.sql),
      ]),
    );
  } finally {
    database.close();
  }
};

interface ExpectedSqliteColumn {
  readonly name: string;
  readonly notNull: boolean;
  readonly primaryKey: boolean;
  readonly type: "INTEGER" | "TEXT";
}

const RUNTIME_SCHEMA_COLUMNS = {
  parser_errors: [
    ["parser_error_id", "INTEGER", false, true],
    ["queue_item_id", "TEXT", true, false],
    ["deduplication_key", "TEXT", false, false],
    ["error_kind", "TEXT", true, false],
    ["message", "TEXT", true, false],
    ["safe_envelope_json", "TEXT", false, false],
    ["created_at", "TEXT", true, false],
  ],
  queue_processing: [
    ["queue_item_id", "TEXT", true, true],
    ["deduplication_key", "TEXT", false, false],
    ["status", "TEXT", true, false],
    ["attempt_count", "INTEGER", true, false],
    ["failure_count", "INTEGER", true, false],
    ["last_error", "TEXT", false, false],
    ["processed_at", "TEXT", true, false],
  ],
  raw_events: [
    ["deduplication_key", "TEXT", true, true],
    ["event_id", "TEXT", true, false],
    ["source_event_id", "TEXT", true, false],
    ["schema_version", "INTEGER", true, false],
    ["adapter", "TEXT", true, false],
    ["adapter_version", "TEXT", true, false],
    ["event_type", "TEXT", true, false],
    ["session_id", "TEXT", false, false],
    ["repo_id", "TEXT", false, false],
    ["branch", "TEXT", false, false],
    ["worktree", "TEXT", false, false],
    ["commit_sha", "TEXT", false, false],
    ["event_timestamp", "TEXT", true, false],
    ["trust", "TEXT", true, false],
    ["content_digest", "TEXT", false, false],
    ["result_digest", "TEXT", false, false],
    ["redaction_rule_version", "INTEGER", true, false],
    ["parse_status", "TEXT", true, false],
    ["safe_envelope_json", "TEXT", true, false],
    ["storage_redaction_applied", "INTEGER", true, false],
    ["first_seen_at", "TEXT", true, false],
    ["last_seen_at", "TEXT", true, false],
    ["delivery_count", "INTEGER", true, false],
  ],
  schema_migrations: [
    ["version", "INTEGER", false, true],
    ["applied_at", "TEXT", true, false],
  ],
} as const satisfies Readonly<
  Record<
    string,
    readonly [
      string,
      ExpectedSqliteColumn["type"],
      boolean,
      boolean,
    ][]
  >
>;

interface ExpectedSqliteIndex {
  readonly columns: readonly string[];
  readonly name?: string;
  readonly origin: "c" | "pk" | "u";
}

const RUNTIME_SCHEMA_INDEXES = {
  deletion_operations: [
    {
      columns: [
        "deletion_id",
      ],
      origin: "pk",
    },
  ],
  evaluation_runs: [
    {
      columns: [
        "run_id",
      ],
      origin: "pk",
    },
  ],
  evidence_links: [
    {
      columns: [
        "link_id",
      ],
      origin: "pk",
    },
  ],
  feedback_events: [
    {
      columns: [
        "feedback_id",
      ],
      origin: "pk",
    },
  ],
  identities: [
    {
      columns: [
        "identity_id",
      ],
      origin: "pk",
    },
  ],
  metrics: [],
  parser_errors: [
    {
      columns: [
        "queue_item_id",
        "error_kind",
      ],
      origin: "u",
    },
  ],
  process_claims: [
    {
      columns: [
        "claim_id",
      ],
      origin: "pk",
    },
  ],
  queue_processing: [
    {
      columns: [
        "queue_item_id",
      ],
      origin: "pk",
    },
  ],
  raw_events: [
    {
      columns: [
        "adapter",
        "adapter_version",
        "session_id",
        "event_type",
        "source_event_id",
      ],
      name: "raw_events_source_identity",
      origin: "c",
    },
    {
      columns: [
        "deduplication_key",
      ],
      origin: "pk",
    },
  ],
  schema_migrations: [],
  work_episodes: [
    {
      columns: [
        "episode_id",
      ],
      origin: "pk",
    },
  ],
} as const satisfies Readonly<
  Record<string, readonly ExpectedSqliteIndex[]>
>;

export class CanonicalSqliteStore {
  readonly #database: DatabaseSync;
  readonly #faultInjector:
    | ((stage: "after_raw_event_insert") => void)
    | undefined;
  readonly #now: () => Date;

  public constructor(
    path: string,
    options: CanonicalSqliteStoreOptions = {},
  ) {
    const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
    if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs <= 0) {
      throw new RangeError("busyTimeoutMs must be a positive integer.");
    }
    const migrations =
      options.migrations ?? DEFAULT_SQLITE_MIGRATIONS;
    this.#validateMigrations(migrations);
    this.#faultInjector = options.faultInjector;
    this.#now = options.now ?? (() => new Date());
    this.#database = new DatabaseSync(path);
    try {
      this.#database.exec("PRAGMA foreign_keys = ON;");
      this.#database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
      this.#database.exec("PRAGMA journal_mode = WAL;");
      this.#applyMigrations(migrations);
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  public close(): void {
    this.#database.close();
  }

  public async backupTo(path: string): Promise<number> {
    await mkdir(dirname(path), {
      recursive: true,
    });
    return backup(this.#database, path);
  }

  public static async restoreFromBackup(
    backupPath: string,
    targetPath: string,
    options: CanonicalSqliteStoreOptions = {},
  ): Promise<CanonicalStoreHealth> {
    await mkdir(dirname(targetPath), {
      recursive: true,
    });
    const restoreId = randomUUID();
    const temporaryPath = `${targetPath}.restore-${restoreId}.tmp`;
    try {
      let source: DatabaseSync | undefined;
      try {
        source = new DatabaseSync(backupPath, {
          readOnly: true,
        });
        CanonicalSqliteStore.#assertRestorableBackup(
          source,
          options.migrations ?? DEFAULT_SQLITE_MIGRATIONS,
        );
        await backup(source, temporaryPath);
      } finally {
        source?.close();
      }

      let health: CanonicalStoreHealth;
      let restored: CanonicalSqliteStore | undefined;
      try {
        restored = new CanonicalSqliteStore(
          temporaryPath,
          options,
        );
        health = restored.health();
      } finally {
        restored?.close();
      }
      if (health.quickCheck !== "ok") {
        throw new Error(
          `Restored SQLite quick_check failed: ${health.quickCheck}.`,
        );
      }
      let validatedSource: DatabaseSync | undefined;
      try {
        validatedSource = new DatabaseSync(temporaryPath, {
          readOnly: true,
        });
        await backup(validatedSource, targetPath);
      } finally {
        validatedSource?.close();
      }

      let installedStore: CanonicalSqliteStore | undefined;
      try {
        installedStore = new CanonicalSqliteStore(
          targetPath,
          options,
        );
        health = installedStore.health();
      } finally {
        installedStore?.close();
      }
      if (health.quickCheck !== "ok") {
        throw new Error(
          `Installed SQLite quick_check failed: ${health.quickCheck}.`,
        );
      }
      return health;
    } finally {
      await CanonicalSqliteStore.#removeDatabaseFiles(
        temporaryPath,
      );
    }
  }

  public health(): CanonicalStoreHealth {
    const journalMode = this.#database
      .prepare("PRAGMA journal_mode;")
      .get() as Readonly<Record<string, unknown>>;
    const busyTimeout = this.#database
      .prepare("PRAGMA busy_timeout;")
      .get() as Readonly<Record<string, unknown>>;
    const quickCheck = this.#database
      .prepare("PRAGMA quick_check;")
      .get() as Readonly<Record<string, unknown>>;
    const userVersion = this.#database
      .prepare("PRAGMA user_version;")
      .get() as Readonly<Record<string, unknown>>;
    return {
      busyTimeoutMs: asNumber(firstColumn(busyTimeout)),
      journalMode: String(firstColumn(journalMode)),
      quickCheck: String(firstColumn(quickCheck)),
      userVersion: asNumber(firstColumn(userVersion)),
    };
  }

  public ingestQueueItem(
    input: CaptureQueueItem,
  ): CanonicalIngestResult {
    const item = captureQueueItemSchema.parse(input);
    const parsedEnvelope = item.envelope;
    if (parsedEnvelope.event.sessionId === undefined) {
      const reason = "Capture envelope sessionId is required.";
      this.#recordRejected(
        item,
        parsedEnvelope.deduplicationKey,
        "invalid_identity",
        reason,
        undefined,
      );
      return {
        status: "rejected",
        deduplicationKey: parsedEnvelope.deduplicationKey,
        reason,
      };
    }
    const expectedDeduplicationKey =
      createCaptureDeduplicationKey({
        adapter: parsedEnvelope.event.adapter,
        adapterVersion: parsedEnvelope.event.adapterVersion,
        eventType: parsedEnvelope.event.eventType,
        sessionId: parsedEnvelope.event.sessionId,
        sourceEventId: parsedEnvelope.sourceEventId,
      });
    const safe = redactCaptureEnvelopeForPersistence(
      parsedEnvelope,
    );
    const safeEnvelopeJson = JSON.stringify(safe.envelope);
    if (
      parsedEnvelope.deduplicationKey !==
        expectedDeduplicationKey ||
      parsedEnvelope.event.eventId !==
        `event-${expectedDeduplicationKey}`
    ) {
      const reason = "Capture envelope identity is inconsistent.";
      this.#recordRejected(
        item,
        expectedDeduplicationKey,
        "invalid_identity",
        reason,
        safeEnvelopeJson,
      );
      return {
        status: "rejected",
        deduplicationKey: expectedDeduplicationKey,
        reason,
      };
    }

    const classification = classifyRawEvent(safe.envelope.event);
    const parseStatus =
      classification.status === "supported"
        ? "supported"
        : classification.status;
    const unsupportedReason =
      classification.status === "supported"
        ? undefined
        : classification.status === "unsupported_event_type"
          ? `Unsupported event type: ${classification.eventType}.`
          : classification.status ===
              "unsupported_adapter_version"
            ? `Unsupported adapter version: ${classification.adapterVersion}.`
            : `Invalid raw event: ${classification.status}.`;
    const now = this.#now().toISOString();

    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const existing = this.#database
        .prepare(
          `SELECT delivery_count, parse_status
             FROM raw_events
            WHERE deduplication_key = ?`,
        )
        .get(expectedDeduplicationKey) as
        | Readonly<Record<string, unknown>>
        | undefined;
      if (existing !== undefined) {
        this.#database
          .prepare(
            `UPDATE raw_events
                SET delivery_count = delivery_count + 1,
                    last_seen_at = ?
              WHERE deduplication_key = ?`,
          )
          .run(now, expectedDeduplicationKey);
        this.#recordQueueProcessing(
          item,
          expectedDeduplicationKey,
          String(existing.parse_status) === "supported"
            ? "duplicate"
            : "unsupported",
          now,
        );
        this.#database.exec("COMMIT;");
        const existingParseStatus = String(
          existing.parse_status,
        );
        return existingParseStatus === "supported"
          ? {
              status: "duplicate",
              deduplicationKey: expectedDeduplicationKey,
            }
          : {
              status: "unsupported",
              deduplicationKey: expectedDeduplicationKey,
              reason: `Previously recorded parse status: ${existingParseStatus}.`,
            };
      }

      const event = safe.envelope.event;
      this.#database
        .prepare(
          `INSERT INTO raw_events (
             deduplication_key,
             event_id,
             source_event_id,
             schema_version,
             adapter,
             adapter_version,
             event_type,
             session_id,
             repo_id,
             branch,
             worktree,
             commit_sha,
             event_timestamp,
             trust,
             content_digest,
             result_digest,
             redaction_rule_version,
             parse_status,
             safe_envelope_json,
             storage_redaction_applied,
             first_seen_at,
             last_seen_at,
             delivery_count
           ) VALUES (
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1
           )`,
        )
        .run(
          expectedDeduplicationKey,
          event.eventId,
          safe.envelope.sourceEventId,
          safe.envelope.schemaVersion,
          event.adapter,
          event.adapterVersion,
          event.eventType,
          optionalText(event.sessionId),
          optionalText(event.repoId),
          optionalText(event.branch),
          optionalText(event.worktree),
          optionalText(event.commitSha),
          event.timestamp,
          event.trust,
          optionalText(safe.envelope.redaction.contentDigest),
          optionalText(event.resultDigest),
          safe.envelope.redaction.ruleVersion,
          parseStatus,
          safeEnvelopeJson,
          safe.redactionApplied ? 1 : 0,
          now,
          now,
        );
      this.#faultInjector?.("after_raw_event_insert");
      if (unsupportedReason !== undefined) {
        this.#insertParserError(
          item.queueItemId,
          expectedDeduplicationKey,
          classification.status,
          unsupportedReason,
          safeEnvelopeJson,
          now,
        );
      }
      this.#recordQueueProcessing(
        item,
        expectedDeduplicationKey,
        unsupportedReason === undefined
          ? "stored"
          : "unsupported",
        now,
      );
      this.#database.exec("COMMIT;");
      return unsupportedReason === undefined
        ? {
            status: "stored",
            deduplicationKey: expectedDeduplicationKey,
          }
        : {
            status: "unsupported",
            deduplicationKey: expectedDeduplicationKey,
            reason: unsupportedReason,
          };
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  public async deduplicationKeys(
    adapter: string,
    adapterVersion: string,
    sessionId: string,
  ): Promise<ReadonlySet<string>> {
    const rows = this.#database
      .prepare(
        `SELECT deduplication_key
           FROM raw_events
          WHERE adapter = ?
            AND adapter_version = ?
            AND session_id = ?`,
      )
      .all(adapter, adapterVersion, sessionId) as readonly Readonly<
      Record<string, unknown>
    >[];
    return new Set(
      rows.map((row) => String(row.deduplication_key)),
    );
  }

  public rawEvent(
    deduplicationKey: string,
  ): CanonicalRawEventRecord | undefined {
    const row = this.#database
      .prepare(
        `SELECT adapter,
                adapter_version,
                deduplication_key,
                delivery_count,
                event_id,
                event_type,
                parse_status,
                safe_envelope_json,
                session_id,
                source_event_id
           FROM raw_events
          WHERE deduplication_key = ?`,
      )
      .get(deduplicationKey) as
      | Readonly<Record<string, unknown>>
      | undefined;
    return row === undefined
      ? undefined
      : {
          adapter: String(row.adapter),
          adapterVersion: String(row.adapter_version),
          deduplicationKey: String(row.deduplication_key),
          deliveryCount: asNumber(row.delivery_count),
          envelope: JSON.parse(
            String(row.safe_envelope_json),
          ) as CaptureEnvelope,
          eventId: String(row.event_id),
          eventType: String(row.event_type),
          parseStatus: String(row.parse_status),
          ...(row.session_id === null
            ? {}
            : {
                sessionId: String(row.session_id),
              }),
          sourceEventId: String(row.source_event_id),
        };
  }

  public parserErrors(): readonly CanonicalParserErrorRecord[] {
    const rows = this.#database
      .prepare(
        `SELECT error_kind, message, queue_item_id
           FROM parser_errors
          ORDER BY parser_error_id`,
      )
      .all() as readonly Readonly<Record<string, unknown>>[];
    return rows.map((row) => ({
      errorKind: String(row.error_kind),
      message: String(row.message),
      queueItemId: String(row.queue_item_id),
    }));
  }

  public queueProcessing(
    queueItemId: string,
  ): QueueProcessingRecord | undefined {
    const row = this.#database
      .prepare(
        `SELECT queue_item_id, status
           FROM queue_processing
          WHERE queue_item_id = ?`,
      )
      .get(queueItemId) as
      | Readonly<Record<string, unknown>>
      | undefined;
    return row === undefined
      ? undefined
      : {
          queueItemId: String(row.queue_item_id),
          status: String(row.status),
        };
  }

  #recordRejected(
    item: CaptureQueueItem,
    deduplicationKey: string,
    errorKind: string,
    message: string,
    safeEnvelopeJson: string | undefined,
  ): void {
    const now = this.#now().toISOString();
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      this.#insertParserError(
        item.queueItemId,
        deduplicationKey,
        errorKind,
        message,
        safeEnvelopeJson,
        now,
      );
      this.#recordQueueProcessing(
        item,
        deduplicationKey,
        "rejected",
        now,
        message,
      );
      this.#database.exec("COMMIT;");
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  #insertParserError(
    queueItemId: string,
    deduplicationKey: string,
    errorKind: string,
    message: string,
    safeEnvelopeJson: string | undefined,
    createdAt: string,
  ): void {
    this.#database
      .prepare(
        `INSERT OR IGNORE INTO parser_errors (
           queue_item_id,
           deduplication_key,
           error_kind,
           message,
           safe_envelope_json,
           created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        queueItemId,
        deduplicationKey,
        errorKind,
        sanitizeDiagnostic(message),
        optionalText(safeEnvelopeJson),
        createdAt,
      );
  }

  #recordQueueProcessing(
    item: CaptureQueueItem,
    deduplicationKey: string,
    status: string,
    processedAt: string,
    lastError?: string,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO queue_processing (
           queue_item_id,
           deduplication_key,
           status,
           attempt_count,
           failure_count,
           last_error,
           processed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(queue_item_id) DO UPDATE SET
           deduplication_key = excluded.deduplication_key,
           status = excluded.status,
           attempt_count = excluded.attempt_count,
           failure_count = excluded.failure_count,
           last_error = excluded.last_error,
           processed_at = excluded.processed_at`,
      )
      .run(
        item.queueItemId,
        deduplicationKey,
        status,
        item.attemptCount,
        item.failureCount,
        optionalText(lastError),
        processedAt,
      );
  }

  #applyMigrations(
    migrations: readonly SqliteMigration[],
  ): void {
    const latestVersion =
      migrations.at(-1)?.version ?? 0;
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const currentVersionRow = this.#database
        .prepare("PRAGMA user_version;")
        .get() as Readonly<Record<string, unknown>>;
      const currentVersion = asNumber(
        currentVersionRow.user_version,
      );
      if (currentVersion > latestVersion) {
        throw new UnsupportedDatabaseVersionError(
          currentVersion,
          latestVersion,
        );
      }
      for (const migration of migrations) {
        if (migration.version <= currentVersion) {
          continue;
        }
        this.#database.exec(migration.sql);
        this.#database
          .prepare(
            `INSERT INTO schema_migrations(version, applied_at)
             VALUES (?, ?)`,
          )
          .run(migration.version, this.#now().toISOString());
        this.#database.exec(
          `PRAGMA user_version = ${migration.version};`,
        );
      }
      CanonicalSqliteStore.#assertCanonicalSchema(
        this.#database,
        latestVersion,
        migrations,
      );
      this.#database.exec("COMMIT;");
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  #validateMigrations(
    migrations: readonly SqliteMigration[],
  ): void {
    if (
      migrations.length === 0 ||
      migrations.some(
        (migration, index) => migration.version !== index + 1,
      )
    ) {
      throw new InvalidMigrationPlanError();
    }
  }

  static #assertCanonicalSchema(
    database: DatabaseSync,
    expectedVersion: number,
    migrations: readonly SqliteMigration[],
  ): void {
    try {
      const migrationRows = database
        .prepare(
          `SELECT version
             FROM schema_migrations
            ORDER BY version`,
        )
        .all() as readonly Readonly<Record<string, unknown>>[];
      const migrationVersions = migrationRows.map((row) =>
        asNumber(row.version),
      );
      const expectedMigrations = Array.from(
        {
          length: expectedVersion,
        },
        (_value, index) => index + 1,
      );
      if (
        JSON.stringify(migrationVersions) !==
        JSON.stringify(expectedMigrations)
      ) {
        throw new InvalidCanonicalSchemaError(
          "SQLite migration ledger is incomplete.",
        );
      }

      const requiredTables = [
        "deletion_operations",
        "evaluation_runs",
        "evidence_links",
        "feedback_events",
        "identities",
        "metrics",
        "parser_errors",
        "process_claims",
        "queue_processing",
        "raw_events",
        "schema_migrations",
        "work_episodes",
      ];
      const tableRows = database
        .prepare(
          `SELECT name
             FROM sqlite_master
            WHERE type = 'table'`,
        )
        .all() as readonly Readonly<Record<string, unknown>>[];
      const tables = new Set(
        tableRows.map((row) => String(row.name)),
      );
      const missingTable = requiredTables.find(
        (table) => !tables.has(table),
      );
      if (missingTable !== undefined) {
        throw new InvalidCanonicalSchemaError(
          `SQLite canonical table ${missingTable} is missing.`,
        );
      }
      const tableList = database
        .prepare("PRAGMA table_list;")
        .all() as readonly Readonly<Record<string, unknown>>[];
      const strictTables = new Set(
        tableList
          .filter((row) => asNumber(row.strict) === 1)
          .map((row) => String(row.name)),
      );
      const nonStrictTable = requiredTables.find(
        (table) => !strictTables.has(table),
      );
      if (nonStrictTable !== undefined) {
        throw new InvalidCanonicalSchemaError(
          `SQLite canonical table ${nonStrictTable} is not STRICT.`,
        );
      }
      for (const table of requiredTables) {
        const foreignKeys = database
          .prepare(
            `PRAGMA foreign_key_list(${sqliteIdentifier(table)});`,
          )
          .all();
        if (foreignKeys.length > 0) {
          throw new InvalidCanonicalSchemaError(
            `SQLite canonical table ${table} has undeclared foreign keys.`,
          );
        }
      }
      const declaredObjectRows = database
        .prepare(
          `SELECT name, sql, type
             FROM sqlite_master
            WHERE sql IS NOT NULL
              AND name NOT LIKE 'sqlite_%'`,
        )
        .all() as readonly Readonly<Record<string, unknown>>[];
      const declaredObjectSql = new Map(
        declaredObjectRows.map((row) => [
          `${String(row.type)}:${String(row.name)}`,
          normalizeSchemaSql(row.sql),
        ]),
      );
      const expectedObjectSql =
        createExpectedCanonicalObjectSql(migrations);
      if (declaredObjectSql.size !== expectedObjectSql.size) {
        throw new InvalidCanonicalSchemaError(
          "SQLite canonical schema contains undeclared objects.",
        );
      }
      for (const [key, expectedSql] of expectedObjectSql) {
        if (declaredObjectSql.get(key) !== expectedSql) {
          throw new InvalidCanonicalSchemaError(
            `SQLite canonical object ${key} does not match the declared schema.`,
          );
        }
      }
      const behaviorObjects = database
        .prepare(
          `SELECT name, type
             FROM sqlite_master
            WHERE type IN ('trigger', 'view')`,
        )
        .all() as readonly Readonly<Record<string, unknown>>[];
      if (behaviorObjects.length > 0) {
        const object = behaviorObjects[0];
        throw new InvalidCanonicalSchemaError(
          `SQLite canonical schema contains undeclared ${String(object?.type)} ${String(object?.name)}.`,
        );
      }

      for (const [table, expectedColumns] of Object.entries(
        RUNTIME_SCHEMA_COLUMNS,
      )) {
        CanonicalSqliteStore.#assertTableColumns(
          database,
          table,
          expectedColumns,
        );
      }
      for (const [table, expectedIndexes] of Object.entries(
        RUNTIME_SCHEMA_INDEXES,
      )) {
        CanonicalSqliteStore.#assertIndexAllowlist(
          database,
          table,
          expectedIndexes,
        );
      }
    } catch (error) {
      if (error instanceof InvalidCanonicalSchemaError) {
        throw error;
      }
      throw new InvalidCanonicalSchemaError(
        "SQLite canonical schema validation failed.",
        {
          cause: error,
        },
      );
    }
  }

  static #assertTableColumns(
    database: DatabaseSync,
    table: string,
    expectedColumns: readonly [
      string,
      ExpectedSqliteColumn["type"],
      boolean,
      boolean,
    ][],
  ): void {
    const rows = database
      .prepare(`PRAGMA table_xinfo(${sqliteIdentifier(table)});`)
      .all() as readonly Readonly<Record<string, unknown>>[];
    if (rows.length !== expectedColumns.length) {
      throw new InvalidCanonicalSchemaError(
        `SQLite table ${table} has an unexpected column count.`,
      );
    }
    expectedColumns.forEach(
      ([name, type, notNull, primaryKey], index) => {
        const row = rows[index];
        if (
          row === undefined ||
          String(row.name) !== name ||
          String(row.type).toUpperCase() !== type ||
          Boolean(asNumber(row.notnull)) !== notNull ||
          Boolean(asNumber(row.pk)) !== primaryKey ||
          asNumber(row.hidden) !== 0
        ) {
          throw new InvalidCanonicalSchemaError(
            `SQLite table ${table} column ${name} is incompatible.`,
          );
        }
      },
    );
  }

  static #assertIndexAllowlist(
    database: DatabaseSync,
    table: string,
    expectedIndexes: readonly ExpectedSqliteIndex[],
  ): void {
    const indexes = database
      .prepare(`PRAGMA index_list(${sqliteIdentifier(table)});`)
      .all() as readonly Readonly<Record<string, unknown>>[];
    if (indexes.length !== expectedIndexes.length) {
      throw new InvalidCanonicalSchemaError(
        `SQLite table ${table} has undeclared indexes.`,
      );
    }
    const unmatched = [
      ...expectedIndexes,
    ];
    for (const index of indexes) {
      const name = String(index.name);
      if (
        asNumber(index.unique) !== 1 ||
        asNumber(index.partial) !== 0
      ) {
        throw new InvalidCanonicalSchemaError(
          `SQLite table ${table} index ${name} is incompatible.`,
        );
      }
      const columns = database
        .prepare(`PRAGMA index_xinfo(${sqliteIdentifier(name)});`)
        .all() as readonly Readonly<Record<string, unknown>>[];
      const keyColumns = columns.filter(
        (column) => asNumber(column.key) === 1,
      );
      const actualColumns = keyColumns.map((column) =>
        String(column.name),
      );
      const matchIndex = unmatched.findIndex(
        (expected) =>
          expected.origin === String(index.origin) &&
          (
            expected.name === undefined ||
            expected.name === name
          ) &&
          JSON.stringify(expected.columns) ===
            JSON.stringify(actualColumns) &&
        keyColumns.every(
          (column) =>
            asNumber(column.desc) === 0 &&
            String(column.coll).toUpperCase() === "BINARY",
        ),
      );
      if (matchIndex === -1) {
        throw new InvalidCanonicalSchemaError(
          `SQLite table ${table} index ${name} is undeclared.`,
        );
      }
      unmatched.splice(matchIndex, 1);
    }
    if (unmatched.length > 0) {
      throw new InvalidCanonicalSchemaError(
        `SQLite table ${table} is missing declared indexes.`,
      );
    }
  }

  static #assertRestorableBackup(
    database: DatabaseSync,
    migrations: readonly SqliteMigration[],
  ): void {
    const latestVersion = migrations.at(-1)?.version ?? 0;
    const versionRow = database
      .prepare("PRAGMA user_version;")
      .get() as Readonly<Record<string, unknown>>;
    const version = asNumber(versionRow.user_version);
    if (version !== latestVersion || version === 0) {
      throw new InvalidCanonicalSchemaError(
        `SQLite backup version ${version} is not the current canonical version ${latestVersion}.`,
      );
    }
    CanonicalSqliteStore.#assertCanonicalSchema(
      database,
      version,
      migrations,
    );
  }

  static #ignoreMissing(error: unknown): void {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }

  static async #removeDatabaseFiles(path: string): Promise<void> {
    await Promise.all(
      [
        path,
        `${path}-shm`,
        `${path}-wal`,
      ].map((file) =>
        unlink(file).catch(CanonicalSqliteStore.#ignoreMissing),
      ),
    );
  }
}
