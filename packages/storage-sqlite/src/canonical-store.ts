import { DatabaseSync } from "node:sqlite";

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

export class CanonicalSqliteStore {
  readonly #database: DatabaseSync;
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
}
