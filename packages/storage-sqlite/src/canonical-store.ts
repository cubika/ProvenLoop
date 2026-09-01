import {
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import {
  mkdir,
  open,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import {
  backup,
  DatabaseSync,
} from "node:sqlite";

import {
  branchContextSchema,
  captureEnvelopeSchema,
  captureQueueItemSchema,
  classifyRawEvent,
  CURRENT_SCHEMA_VERSION,
  contextUseRecordSchema,
  correctionKeySchema,
  correctionOpportunitySchema,
  deletionOperationSchema,
  deletionTargetTypeSchema,
  episodeAssociationSchema,
  episodeGroupingCorrectionSchema,
  feedbackEventSchema,
  knowledgeCandidateSchema,
  workEpisodeSchema,
  type BranchContext,
  type CaptureEnvelope,
  type CaptureQueueItem,
  type ContextUseRecord,
  type CorrectionKey,
  type CorrectionOpportunity,
  type DeletionOperation,
  type DeletionPlannedIdentity,
  type DeletionIdentityType,
  type DeletionTargetType,
  type EpisodeAssociation,
  type EpisodeGroupingCorrection,
  type FeedbackEvent,
  type KnowledgeCandidate,
  type WorkEpisode,
} from "@provenloop/contracts";
import {
  createCaptureDeduplicationKey,
  deletionIdentityDigest,
  redactCaptureEnvelopeForPersistence,
  sanitizeDiagnostic,
  sha256,
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

export interface WorkEpisodeProjectionWriteResult {
  readonly associations: number;
  readonly corrections: number;
  readonly episodes: number;
}

export interface CorrectionProjectionWriteResult {
  readonly correctionKeys: number;
  readonly opportunities: number;
}

export interface CanonicalDeletionTarget {
  readonly targetId: string;
  readonly targetType: DeletionTargetType;
}

export interface CanonicalDeletionMutationResult {
  readonly affectedSessionIds: readonly string[];
  readonly dependentIds: readonly string[];
  readonly sourceIds: readonly string[];
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
  {
    version: 2,
    sql: `
      CREATE TABLE branch_contexts (
        branch_context_id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        branch TEXT NOT NULL,
        head_sha TEXT NOT NULL,
        body_json TEXT NOT NULL,
        source_digest TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT
      ) STRICT;

      CREATE UNIQUE INDEX branch_context_scope
        ON branch_contexts(repo_id, branch);
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE knowledge_candidates (
        knowledge_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        body_json TEXT NOT NULL,
        source_digest TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE context_use_records (
        request_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        body_json TEXT NOT NULL,
        source_digest TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX context_use_session
        ON context_use_records(session_id, created_at);
    `,
  },
  {
    version: 5,
    sql: `
      CREATE TABLE session_mutes (
        feedback_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX session_mutes_session
        ON session_mutes(session_id, created_at);

      CREATE INDEX session_mutes_target
        ON session_mutes(target_id);

      INSERT INTO session_mutes (
        feedback_id,
        session_id,
        target_id,
        created_at
      )
      SELECT feedback_id,
             json_extract(body_json, '$.evidenceRef'),
             json_extract(body_json, '$.targetId'),
             created_at
        FROM feedback_events
       WHERE json_extract(body_json, '$.kind') = 'mute_session';
    `,
  },
  {
    version: 6,
    sql: `
      CREATE TABLE correction_keys (
        correction_key_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        scope TEXT NOT NULL,
        scope_id TEXT,
        body_json TEXT NOT NULL,
        source_digest TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX correction_keys_scope
        ON correction_keys(scope, scope_id);

      CREATE TABLE correction_opportunities (
        opportunity_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        correction_key_id TEXT NOT NULL,
        episode_id TEXT NOT NULL,
        applicable INTEGER NOT NULL,
        body_json TEXT NOT NULL,
        source_digest TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX correction_opportunities_key
        ON correction_opportunities(correction_key_id, created_at);

      CREATE INDEX correction_opportunities_episode
        ON correction_opportunities(episode_id);
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

const normalizedKnowledgeCandidate = (
  input: KnowledgeCandidate,
): KnowledgeCandidate => {
  const parsed = knowledgeCandidateSchema.parse(input);
  return knowledgeCandidateSchema.parse({
    ...parsed,
    sourceEvidenceIds: parsed.sourceEvidenceIds.map(
      (identifier) =>
        /^(?:event-)?[a-f0-9]{64}$/iu.test(identifier)
          ? identifier.toLowerCase()
          : identifier,
    ),
  });
};

const firstColumn = (
  row: Readonly<Record<string, unknown>>,
): unknown => Object.values(row)[0];

const sqliteIdentifier = (value: string): string =>
  `"${value.replaceAll("\"", "\"\"")}"`;

const normalizeSchemaSql = (value: unknown): string =>
  String(value).replaceAll(/\s+/gu, " ").trim();

interface TypedDeletionReferences {
  readonly deduplication: Set<string>;
  readonly episode: Set<string>;
  readonly event: Set<string>;
  readonly record: Set<string>;
  readonly session: Set<string>;
}

const normalizedReferenceKey = (key: string): string =>
  key.toLowerCase().replaceAll(/[-_.]/gu, "");

const stringValues = (value: unknown): readonly string[] =>
  typeof value === "string"
    ? [
        value,
      ]
    : Array.isArray(value)
      ? value.filter(
          (item): item is string => typeof item === "string",
        )
      : [];

const bodyReferences = (
  input: unknown,
  references: TypedDeletionReferences,
): boolean => {
  if (input === null || typeof input !== "object") {
    return false;
  }
  if (Array.isArray(input)) {
    return input.some((value) =>
      bodyReferences(value, references),
    );
  }
  const record = input as Readonly<Record<string, unknown>>;
  if (
    record.targetType === "episode" &&
    typeof record.targetId === "string" &&
    references.episode.has(record.targetId)
  ) {
    return true;
  }
  if (
    record.targetType === "process_claim" &&
    typeof record.targetId === "string" &&
    references.record.has(record.targetId)
  ) {
    return true;
  }
  if (
    record.targetType === "knowledge" &&
    typeof record.targetId === "string" &&
    references.record.has(`knowledge:${record.targetId}`)
  ) {
    return true;
  }
  if (
    record.kind === "mute_session" &&
    typeof record.evidenceRef === "string" &&
    references.session.has(record.evidenceRef)
  ) {
    return true;
  }
  for (const [
    key,
    value,
  ] of Object.entries(record)) {
    const normalized = normalizedReferenceKey(key);
    const values = stringValues(value);
    const matched =
      [
        "episodeid",
        "sourceepisodeids",
      ].includes(normalized)
        ? values.some((id) => references.episode.has(id))
        : [
              "leftsessionid",
              "rightsessionid",
              "sessionid",
              "sessionids",
            ].includes(normalized)
          ? values.some((id) => references.session.has(id))
          : [
                "correctioneventids",
                "eventid",
                "parenteventid",
                "sourceid",
                "sourcecorrectioneventids",
                "sourceeventids",
              ].includes(normalized)
            ? values.some(
                (id) =>
                  references.event.has(id) ||
                  references.event.has(id.toLowerCase()),
              )
            : [
                  "availabilityevidenceids",
                  "correctionids",
                  "evidenceid",
                  "evidenceids",
                  "evidenceref",
                  "invocationids",
                  "sourceevidenceids",
                  "supportingevidenceids",
                  "verificationevidenceids",
                ].includes(normalized)
              ? values.some(
                  (id) =>
                      references.deduplication.has(id) ||
                      references.deduplication.has(
                        id.toLowerCase(),
                      ) ||
                      references.event.has(id) ||
                      references.event.has(id.toLowerCase()) ||
                      references.record.has(id),
                  )
              : [
                      "candidateknowledgeids",
                      "conflictswith",
                      "knowledgeid",
                      "supersedes",
                    ].includes(normalized)
                  ? values.some((id) =>
                      references.record.has(`knowledge:${id}`),
                    )
                  : [
                        "appliedknowledgeids",
                        "returnedknowledgeids",
                      ].includes(normalized)
                    ? values.some((id) =>
                        references.record.has(id),
                      )
              : normalized === "correctionkeyid"
                ? values.some((id) => references.record.has(id))
              : false;
    if (matched || bodyReferences(value, references)) {
      return true;
    }
  }
  return false;
};

const placeholders = (count: number): string =>
  Array.from({
    length: count,
  }, () => "?").join(", ");

const validateDeletionTargetId = (
  targetType: DeletionTargetType,
  targetId: string,
): void => {
  if (
    targetType === "source" &&
    !/^(?:event-)?[a-f0-9]{64}$/iu.test(targetId)
  ) {
    throw new Error(
      "Source deletion requires a canonical event ID or deduplication key.",
    );
  }
};

const normalizedDeletionTargetId = (
  targetType: DeletionTargetType,
  targetId: string,
): string =>
  targetType === "source"
    ? targetId.toLowerCase()
    : targetId;

const sourceIdentityForms = (targetId: string): readonly string[] =>
  targetId.startsWith("event-")
    ? [
        targetId,
        targetId.slice("event-".length),
      ]
    : [
        targetId,
        `event-${targetId}`,
      ];

const deletionIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

interface LoadedDeletionIdentityKey {
  readonly key: string;
}

const loadDeletionIdentityKey = (
  path: string,
): LoadedDeletionIdentityKey => {
  if (path === ":memory:") {
    return {
      key: randomBytes(32).toString("hex"),
    };
  }
  const keyPath = `${path}.deletion.key`;
  try {
    const existing = readFileSync(keyPath, "utf8").trim();
    if (/^[a-f0-9]{64}$/u.test(existing)) {
      return {
        key: existing,
      };
    }
    throw new Error("Canonical deletion identity key is malformed.");
  } catch (error) {
    if (
      !(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      )
    ) {
      throw error;
    }
  }
  if (existsSync(path)) {
    let existingDatabase: DatabaseSync | undefined;
    try {
      existingDatabase = new DatabaseSync(path, {
        readOnly: true,
      });
      const table = existingDatabase
        .prepare(
          `SELECT COUNT(*) AS count
             FROM sqlite_master
            WHERE type = 'table'
              AND name = 'deletion_operations'`,
        )
        .get() as Readonly<Record<string, unknown>>;
      if (asNumber(table.count) > 0) {
        const operations = existingDatabase
          .prepare(
            `SELECT COUNT(*) AS count
               FROM deletion_operations`,
          )
          .get() as Readonly<Record<string, unknown>>;
        if (asNumber(operations.count) > 0) {
          throw new InvalidCanonicalSchemaError(
            "Canonical deletion identity key is missing.",
          );
        }
      }
    } finally {
      existingDatabase?.close();
    }
  }
  const generated = randomBytes(32).toString("hex");
  try {
    const descriptor = openSync(keyPath, "wx");
    try {
      writeFileSync(descriptor, generated, "utf8");
    } finally {
      closeSync(descriptor);
    }
    return {
      key: generated,
    };
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "EEXIST"
    ) {
      const existing = readFileSync(keyPath, "utf8").trim();
      if (/^[a-f0-9]{64}$/u.test(existing)) {
        return {
          key: existing,
        };
      }
    }
    throw error;
  }
};

const deleteDependentRows = (
  database: DatabaseSync,
  table: string,
  idColumn: string,
  bodyColumn: string,
  references: TypedDeletionReferences,
  dependentIds: Set<string>,
): number => {
  let deleted = 0;
  const rows = database
    .prepare(
      `SELECT ${idColumn} AS id, ${bodyColumn} AS body
         FROM ${table}`,
    )
    .all() as readonly Readonly<Record<string, unknown>>[];
  const remove = database.prepare(
    `DELETE FROM ${table} WHERE ${idColumn} = ?`,
  );
  for (const row of rows) {
    const parsed = JSON.parse(String(row.body)) as unknown;
    if (!bodyReferences(parsed, references)) {
      continue;
    }
    const id = String(row.id);
    remove.run(id);
    const reference =
      table === "knowledge_candidates"
        ? `knowledge:${id}`
        : id;
    dependentIds.add(reference);
    references.record.add(reference);
    deleted += 1;
  }
  return deleted;
};

const deleteRebuildableProjectionRows = (
  database: DatabaseSync,
  table: string,
  idColumn: string,
  bodyColumn: string,
  references: TypedDeletionReferences,
): number => {
  let deleted = 0;
  const rows = database
    .prepare(
      `SELECT ${idColumn} AS id, ${bodyColumn} AS body
         FROM ${table}`,
    )
    .all() as readonly Readonly<Record<string, unknown>>[];
  const remove = database.prepare(
    `DELETE FROM ${table} WHERE ${idColumn} = ?`,
  );
  for (const row of rows) {
    const parsed = JSON.parse(String(row.body)) as unknown;
    if (!bodyReferences(parsed, references)) {
      continue;
    }
    const id = String(row.id);
    remove.run(id);
    references.record.add(
      table === "branch_contexts"
        ? `branch-context:${id}`
        : id,
    );
    deleted += 1;
  }
  return deleted;
};

const deleteEvidenceLinkRows = (
  database: DatabaseSync,
  references: TypedDeletionReferences,
  dependentIds: Set<string>,
  dependencySeedIds: Set<string>,
): number => {
  let deleted = 0;
  const rows = database
    .prepare(
      `SELECT link_id, body_json
         FROM evidence_links`,
    )
    .all() as readonly Readonly<Record<string, unknown>>[];
  const remove = database.prepare(
    "DELETE FROM evidence_links WHERE link_id = ?",
  );
  for (const row of rows) {
    const parsed = JSON.parse(String(row.body_json)) as unknown;
    if (!bodyReferences(parsed, references)) {
      continue;
    }
    const id = String(row.link_id);
    remove.run(id);
    if (episodeAssociationSchema.safeParse(parsed).success) {
      dependencySeedIds.add(id);
    } else {
      dependentIds.add(id);
    }
    references.record.add(id);
    deleted += 1;
  }
  return deleted;
};

const deleteIdentityRows = (
  database: DatabaseSync,
  references: TypedDeletionReferences,
  dependentIds: Set<string>,
): number => {
  let deleted = 0;
  const rows = database
    .prepare(
      `SELECT identity_id, identity_type, canonical_value
         FROM identities`,
    )
    .all() as readonly Readonly<Record<string, unknown>>[];
  const remove = database.prepare(
    "DELETE FROM identities WHERE identity_id = ?",
  );
  for (const row of rows) {
    const identityId = String(row.identity_id);
    const identityType = String(row.identity_type)
      .toLowerCase();
    const canonicalValue = String(row.canonical_value);
    const matches =
      references.record.has(identityId) ||
      references.record.has(canonicalValue) ||
      (
        identityType.includes("alias") &&
        (
          references.event.has(canonicalValue) ||
          references.session.has(canonicalValue) ||
          references.episode.has(canonicalValue)
        )
      ) ||
      (
        identityType.includes("dedup") &&
        references.deduplication.has(canonicalValue)
      ) ||
      (
        identityType.includes("session") &&
        references.session.has(canonicalValue)
      ) ||
      (
        identityType.includes("episode") &&
        references.episode.has(canonicalValue)
      ) ||
      (
        identityType.includes("event") &&
        references.event.has(canonicalValue)
      );
    if (!matches) {
      continue;
    }
    remove.run(identityId);
    dependentIds.add(identityId);
    references.record.add(identityId);
    deleted += 1;
  }
  return deleted;
};

const feedbackMutatesKnowledge = (
  event: FeedbackEvent,
): boolean =>
  event.targetType === "knowledge" &&
  ![
    "irrelevant",
    "mute_session",
  ].includes(event.kind);

const feedbackIntentDigest = (
  event: FeedbackEvent,
): string => {
  const {
    timestamp: _timestamp,
    ...intent
  } = event;
  void _timestamp;
  return sha256(intent);
};

const deleteFeedbackRows = (
  database: DatabaseSync,
  references: TypedDeletionReferences,
  dependentIds: Set<string>,
  affectedKnowledgeIds: Set<string>,
): number => {
  let deleted = 0;
  const rows = database
    .prepare(
      `SELECT feedback_id, body_json
         FROM feedback_events`,
    )
    .all() as readonly Readonly<Record<string, unknown>>[];
  const remove = database.prepare(
    "DELETE FROM feedback_events WHERE feedback_id = ?",
  );
  for (const row of rows) {
    const parsed = JSON.parse(String(row.body_json)) as unknown;
    if (!bodyReferences(parsed, references)) {
      continue;
    }
    const id = String(row.feedback_id);
    const event = feedbackEventSchema.parse(parsed);
    remove.run(id);
    dependentIds.add(id);
    references.record.add(id);
    if (feedbackMutatesKnowledge(event)) {
      affectedKnowledgeIds.add(event.targetId);
    }
    deleted += 1;
  }
  return deleted;
};

const deleteSessionMuteRows = (
  database: DatabaseSync,
  references: TypedDeletionReferences,
): number => {
  let deleted = 0;
  const rows = database
    .prepare(
      `SELECT session_id, feedback_id, target_id
         FROM session_mutes`,
    )
    .all() as readonly Readonly<Record<string, unknown>>[];
  const remove = database.prepare(
    "DELETE FROM session_mutes WHERE feedback_id = ?",
  );
  for (const row of rows) {
    const sessionId = String(row.session_id);
    const feedbackId = String(row.feedback_id);
    const targetId = String(row.target_id);
    if (
      !references.session.has(sessionId) &&
      !references.record.has(feedbackId) &&
      !references.record.has(`knowledge:${targetId}`)
    ) {
      continue;
    }
    remove.run(feedbackId);
    deleted += 1;
  }
  return deleted;
};

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
  branch_contexts: [
    ["branch_context_id", "TEXT", true, true],
    ["repo_id", "TEXT", true, false],
    ["branch", "TEXT", true, false],
    ["head_sha", "TEXT", true, false],
    ["body_json", "TEXT", true, false],
    ["source_digest", "TEXT", true, false],
    ["updated_at", "TEXT", true, false],
    ["expires_at", "TEXT", false, false],
  ],
  correction_keys: [
    ["correction_key_id", "TEXT", true, true],
    ["schema_version", "INTEGER", true, false],
    ["scope", "TEXT", true, false],
    ["scope_id", "TEXT", false, false],
    ["body_json", "TEXT", true, false],
    ["source_digest", "TEXT", true, false],
    ["created_at", "TEXT", true, false],
  ],
  correction_opportunities: [
    ["opportunity_id", "TEXT", true, true],
    ["schema_version", "INTEGER", true, false],
    ["correction_key_id", "TEXT", true, false],
    ["episode_id", "TEXT", true, false],
    ["applicable", "INTEGER", true, false],
    ["body_json", "TEXT", true, false],
    ["source_digest", "TEXT", true, false],
    ["created_at", "TEXT", true, false],
  ],
  context_use_records: [
    ["request_id", "TEXT", true, true],
    ["schema_version", "INTEGER", true, false],
    ["session_id", "TEXT", true, false],
    ["body_json", "TEXT", true, false],
    ["source_digest", "TEXT", true, false],
    ["created_at", "TEXT", true, false],
  ],
  knowledge_candidates: [
    ["knowledge_id", "TEXT", true, true],
    ["schema_version", "INTEGER", true, false],
    ["body_json", "TEXT", true, false],
    ["source_digest", "TEXT", true, false],
    ["created_at", "TEXT", true, false],
    ["updated_at", "TEXT", true, false],
  ],
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
  session_mutes: [
    ["feedback_id", "TEXT", true, true],
    ["session_id", "TEXT", true, false],
    ["target_id", "TEXT", true, false],
    ["created_at", "TEXT", true, false],
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
  readonly unique?: boolean;
}

const RUNTIME_SCHEMA_INDEXES = {
  branch_contexts: [
    {
      columns: [
        "branch_context_id",
      ],
      origin: "pk",
    },
    {
      columns: [
        "repo_id",
        "branch",
      ],
      name: "branch_context_scope",
      origin: "c",
    },
  ],
  correction_keys: [
    {
      columns: [
        "correction_key_id",
      ],
      origin: "pk",
    },
    {
      columns: [
        "scope",
        "scope_id",
      ],
      name: "correction_keys_scope",
      origin: "c",
      unique: false,
    },
  ],
  correction_opportunities: [
    {
      columns: [
        "episode_id",
      ],
      name: "correction_opportunities_episode",
      origin: "c",
      unique: false,
    },
    {
      columns: [
        "correction_key_id",
        "created_at",
      ],
      name: "correction_opportunities_key",
      origin: "c",
      unique: false,
    },
    {
      columns: [
        "opportunity_id",
      ],
      origin: "pk",
    },
  ],
  context_use_records: [
    {
      columns: [
        "session_id",
        "created_at",
      ],
      name: "context_use_session",
      origin: "c",
      unique: false,
    },
    {
      columns: [
        "request_id",
      ],
      origin: "pk",
    },
  ],
  knowledge_candidates: [
    {
      columns: [
        "knowledge_id",
      ],
      origin: "pk",
    },
  ],
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
  session_mutes: [
    {
      columns: [
        "feedback_id",
      ],
      origin: "pk",
    },
    {
      columns: [
        "session_id",
        "created_at",
      ],
      name: "session_mutes_session",
      origin: "c",
      unique: false,
    },
    {
      columns: [
        "target_id",
      ],
      name: "session_mutes_target",
      origin: "c",
      unique: false,
    },
  ],
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
  readonly #deletionIdentityKey: string;
  readonly #faultInjector:
    | ((stage: "after_raw_event_insert") => void)
    | undefined;
  readonly #now: () => Date;
  readonly #path: string;

  public constructor(
    path: string,
    options: CanonicalSqliteStoreOptions = {},
  ) {
    this.#path = path;
    const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
    if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs <= 0) {
      throw new RangeError("busyTimeoutMs must be a positive integer.");
    }
    const migrations =
      options.migrations ?? DEFAULT_SQLITE_MIGRATIONS;
    this.#validateMigrations(migrations);
    const deletionIdentityKey = loadDeletionIdentityKey(path);
    this.#deletionIdentityKey = deletionIdentityKey.key;
    this.#faultInjector = options.faultInjector;
    this.#now = options.now ?? (() => new Date());
    this.#database = new DatabaseSync(path);
    try {
      this.#database.exec("PRAGMA foreign_keys = ON;");
      this.#database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
      this.#database.exec("PRAGMA journal_mode = WAL;");
      this.#applyMigrations(migrations);
      this.#validateDeletionIdentityKey();
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
    const pages = await backup(this.#database, path);
    await writeFile(
      `${path}.deletion.key`,
      this.#deletionIdentityKey,
      "utf8",
    );
    return pages;
  }

  public static async restoreFromBackup(
    backupPath: string,
    targetPath: string,
    options: CanonicalSqliteStoreOptions = {},
  ): Promise<CanonicalStoreHealth> {
    await mkdir(dirname(targetPath), {
      recursive: true,
    });
    const restoreBarrierPath = `${targetPath}.restore.lock`;
    const restoreBarrier = await open(restoreBarrierPath, "wx");
    await restoreBarrier.writeFile(
      `${process.pid}\n`,
      "utf8",
    );
    await restoreBarrier.sync();
    const requiredTombstones = new Map<string, DeletionOperation>();
    let installedIncompleteDeletion = false;
    let requiredDeletionKey: string | undefined;
    const restoreId = randomUUID();
    const temporaryPath = `${targetPath}.restore-${restoreId}.tmp`;
    try {
      if (existsSync(targetPath)) {
      let current: DatabaseSync | undefined;
      try {
        current = new DatabaseSync(targetPath);
        current.exec("BEGIN EXCLUSIVE;");
        const hasTable = current
          .prepare(
            `SELECT COUNT(*) AS count
               FROM sqlite_master
              WHERE type = 'table'
                AND name = 'deletion_operations'`,
          )
          .get() as Readonly<Record<string, unknown>>;
        if (asNumber(hasTable.count) > 0) {
          const rows = current
            .prepare(
              `SELECT body_json
                 FROM deletion_operations
                ORDER BY updated_at`,
            )
            .all() as readonly Readonly<Record<string, unknown>>[];
          for (const row of rows) {
            const operation = deletionOperationSchema.parse(
              JSON.parse(String(row.body_json)) as unknown,
            );
            if (operation.status === "completed") {
              requiredTombstones.set(
                operation.deletionId,
                operation,
              );
            } else {
              installedIncompleteDeletion = true;
            }
          }
        }
        current.exec("COMMIT;");
      } finally {
        try {
          current?.exec("ROLLBACK;");
        } catch {
          // The exclusive transaction may already be committed.
        }
        current?.close();
      }
      if (requiredTombstones.size > 0) {
        requiredDeletionKey = (
          await readFile(`${targetPath}.deletion.key`, "utf8")
        ).trim();
      }
      }
      if (installedIncompleteDeletion) {
        throw new InvalidCanonicalSchemaError(
          "Cannot restore while a deletion operation is incomplete.",
        );
      }
      let backupDeletionKey: string | undefined;
      let source: DatabaseSync | undefined;
      try {
        source = new DatabaseSync(backupPath, {
          readOnly: true,
        });
        CanonicalSqliteStore.#assertRestorableBackup(
          source,
          options.migrations ?? DEFAULT_SQLITE_MIGRATIONS,
        );
        const backupOperationRows = source
          .prepare(
            `SELECT body_json
               FROM deletion_operations
              ORDER BY updated_at`,
          )
          .all() as readonly Readonly<Record<string, unknown>>[];
        try {
          backupDeletionKey = (
            await readFile(`${backupPath}.deletion.key`, "utf8")
          ).trim();
        } catch (error) {
          if (
            !(
              error instanceof Error &&
              "code" in error &&
              error.code === "ENOENT"
            ) ||
            backupOperationRows.length > 0
          ) {
            throw error;
          }
          backupDeletionKey = randomBytes(32).toString("hex");
        }
        if (!/^[a-f0-9]{64}$/u.test(backupDeletionKey)) {
          throw new InvalidCanonicalSchemaError(
            "Backup deletion identity key is malformed.",
          );
        }
        if (
          backupOperationRows.length > 0 &&
          requiredDeletionKey !== undefined &&
          backupDeletionKey !== requiredDeletionKey
        ) {
          throw new InvalidCanonicalSchemaError(
            "Backup deletion identity key does not match the installed database.",
          );
        }
        if (requiredTombstones.size > 0) {
          const backupTombstones = new Map(
            backupOperationRows.flatMap((row) => {
              const operation = deletionOperationSchema.parse(
                JSON.parse(String(row.body_json)) as unknown,
              );
              if (operation.status !== "completed") {
                return [];
              }
              return [
                [
                  operation.deletionId,
                  operation,
                ] as const,
              ];
            }),
          );
          for (const [
            deletionId,
            required,
          ] of requiredTombstones) {
            const candidate = backupTombstones.get(deletionId);
            if (
              candidate === undefined ||
              candidate.targetDigest !== required.targetDigest ||
              candidate.tombstoneKeyVerifier !==
                required.tombstoneKeyVerifier ||
              JSON.stringify(candidate.blockedIdentityDigests) !==
                JSON.stringify(required.blockedIdentityDigests)
            ) {
              throw new InvalidCanonicalSchemaError(
                "Backup is missing an installed deletion tombstone.",
              );
            }
          }
        }
        await backup(source, temporaryPath);
        await writeFile(
          `${temporaryPath}.deletion.key`,
          backupDeletionKey,
          "utf8",
        );
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
        await writeFile(
          `${targetPath}.deletion.key`,
          backupDeletionKey,
          "utf8",
        );
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
      await restoreBarrier.close();
      await unlink(restoreBarrierPath).catch(
        CanonicalSqliteStore.#ignoreMissing,
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

  public hasActiveDeletion(): boolean {
    const row = this.#database
      .prepare(
        `SELECT COUNT(*) AS count
           FROM deletion_operations
          WHERE status IN ('running', 'completing', 'failed')`,
      )
      .get() as Readonly<Record<string, unknown>>;
    return asNumber(row.count) > 0;
  }

  public beginDeletion(
    target: CanonicalDeletionTarget,
    deletionId: string = randomUUID(),
  ): DeletionOperation {
    this.#assertNoRestoreBarrier();
    const targetType = deletionTargetTypeSchema.parse(
      target.targetType,
    );
    const targetId = normalizedDeletionTargetId(
      targetType,
      target.targetId.trim(),
    );
    if (
      targetId.length === 0 ||
      !deletionIdPattern.test(deletionId)
    ) {
      throw new Error(
        "Deletion target and operation IDs must be non-empty.",
      );
    }
    validateDeletionTargetId(targetType, targetId);
    const targetDigest = deletionIdentityDigest(
      "target",
      `${targetType}:${targetId}`,
      this.#deletionIdentityKey,
    );
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const existing = (this.#database
        .prepare(
          `SELECT body_json
             FROM deletion_operations
            ORDER BY updated_at DESC`,
        )
        .all() as readonly Readonly<Record<string, unknown>>[])
        .map((row) =>
          deletionOperationSchema.parse(
            JSON.parse(String(row.body_json)) as unknown,
          ),
        );
      const active = existing.find(
        (candidate) =>
          candidate.status === "running" ||
          candidate.status === "completing",
      );
      if (active !== undefined) {
        if (active.targetDigest !== targetDigest) {
          throw new Error(
            "A deletion operation is already active.",
          );
        }
        this.#database.exec("COMMIT;");
        return active;
      }
      const completed = existing.find(
        (candidate) =>
          candidate.status === "completed" &&
          candidate.targetDigest === targetDigest,
      );
      if (completed !== undefined) {
        this.#database.exec("COMMIT;");
        return completed;
      }
      const resumable = existing.find(
        (candidate) =>
          candidate.status === "failed" &&
          candidate.targetDigest === targetDigest,
      );
      if (resumable !== undefined) {
        const resumed = deletionOperationSchema.parse({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        activeTargetId: targetId,
        attemptCount: resumable.attemptCount + 1,
        blockedIdentityDigests:
          resumable.blockedIdentityDigests,
        deletedDependentCount: 0,
        deletedQueueItemCount: 0,
        deletedSourceCount: 0,
        deletionId: resumable.deletionId,
        ...(resumable.plannedAffectedSessionIds === undefined
          ? {}
          : {
              plannedAffectedSessionIds:
                resumable.plannedAffectedSessionIds,
            }),
        ...(resumable.plannedDependentIds === undefined
          ? {}
          : {
              plannedDependentIds:
                resumable.plannedDependentIds,
            }),
        ...(resumable.plannedDependencySeedIds === undefined
          ? {}
          : {
              plannedDependencySeedIds:
                resumable.plannedDependencySeedIds,
            }),
        ...(resumable.plannedSourceIds === undefined
          ? {}
          : {
              plannedSourceIds: resumable.plannedSourceIds,
            }),
        ...(resumable.plannedQueueItemIds === undefined
          ? {}
          : {
              plannedQueueItemIds:
                resumable.plannedQueueItemIds,
            }),
        ...(resumable.plannedQueueIdentities === undefined
          ? {}
          : {
              plannedQueueIdentities:
                resumable.plannedQueueIdentities,
            }),
        requestedAt: resumable.requestedAt,
        status: "running",
        targetDigest,
        targetType,
        tombstoneKeyVerifier:
          this.#deletionIdentityKeyVerifier(),
      });
        this.#writeDeletionOperation(resumed);
        this.#database.exec("COMMIT;");
        return resumed;
      }
      if (
        existing.some((candidate) => candidate.status === "failed")
      ) {
        throw new Error(
          "A failed deletion must be resumed before another deletion starts.",
        );
      }
      if (
        targetType === "knowledge" &&
        this.knowledgeCandidates([
          targetId,
        ]).length === 0
      ) {
        throw new Error(
          `Knowledge ${targetId} does not exist.`,
        );
      }
      const operation = deletionOperationSchema.parse({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      activeTargetId: targetId,
      attemptCount: 1,
      blockedIdentityDigests: [],
      deletedDependentCount: 0,
      deletedQueueItemCount: 0,
      deletedSourceCount: 0,
      deletionId,
      requestedAt: this.#now().toISOString(),
      status: "running",
      targetDigest,
      targetType,
      tombstoneKeyVerifier:
        this.#deletionIdentityKeyVerifier(),
    });
      this.#database
        .prepare(
          `INSERT INTO deletion_operations (
             deletion_id,
             status,
             body_json,
             created_at,
             updated_at
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          operation.deletionId,
          operation.status,
          JSON.stringify(operation),
          operation.requestedAt,
          operation.requestedAt,
        );
      this.#database.exec("COMMIT;");
      return operation;
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  public deletionOperation(
    deletionId: string,
  ): DeletionOperation | undefined {
    const row = this.#database
      .prepare(
        `SELECT body_json
           FROM deletion_operations
          WHERE deletion_id = ?`,
      )
      .get(deletionId) as
      | Readonly<Record<string, unknown>>
      | undefined;
    return row === undefined
      ? undefined
      : deletionOperationSchema.parse(
          JSON.parse(String(row.body_json)) as unknown,
        );
  }

  public deleteCanonicalTarget(
    deletionId: string,
    target: CanonicalDeletionTarget,
  ): CanonicalDeletionMutationResult {
    this.#assertNoRestoreBarrier();
    let operation = this.deletionOperation(deletionId);
    if (operation?.status !== "running") {
      throw new Error(
        `Deletion operation ${deletionId} is not active.`,
      );
    }
    const targetType = deletionTargetTypeSchema.parse(
      target.targetType,
    );
    const targetId = normalizedDeletionTargetId(
      targetType,
      target.targetId.trim(),
    );
    validateDeletionTargetId(targetType, targetId);
    if (
      operation.targetType !== targetType ||
      operation.targetDigest !==
        deletionIdentityDigest(
          "target",
          `${targetType}:${targetId}`,
          this.#deletionIdentityKey,
        )
    ) {
      throw new Error(
        "Deletion target does not match the active operation.",
      );
    }
    const allRawRows = this.#database
      .prepare(
        `SELECT deduplication_key,
                event_id,
                session_id,
                safe_envelope_json
           FROM raw_events`,
      )
      .all() as readonly Readonly<Record<string, unknown>>[];
    const allParserRows = this.#database
      .prepare(
        `SELECT parser_error_id,
                queue_item_id,
                deduplication_key,
                safe_envelope_json
           FROM parser_errors`,
      )
      .all() as readonly Readonly<Record<string, unknown>>[];
    const episodeTarget =
      targetType === "episode"
        ? this.workEpisodes().find(
            (episode) => episode.episodeId === targetId,
          )
        : undefined;
    const sourceIds = new Set(
      operation.plannedSourceIds ??
        (
          targetType === "source"
            ? sourceIdentityForms(targetId)
            : []
        ),
    );
    const dependentIds = new Set(
      operation.plannedDependentIds ?? [],
    );
    if (targetType === "knowledge") {
      dependentIds.add(`knowledge:${targetId}`);
    }
    const dependencySeedIds = new Set(
      operation.plannedDependencySeedIds ?? [],
    );
    if (targetType === "episode") {
      dependencySeedIds.add(targetId);
    }
    const targetSessionIds = new Set(
      operation.plannedAffectedSessionIds ?? [],
    );
    const candidateSessionIds = new Set(targetSessionIds);
    if (targetType === "session") {
      targetSessionIds.add(targetId);
      candidateSessionIds.add(targetId);
    }
    if (episodeTarget !== undefined) {
      for (const eventId of episodeTarget.sourceEventIds) {
        sourceIds.add(eventId);
      }
      for (const sessionId of episodeTarget.sessionIds) {
        targetSessionIds.add(sessionId);
        candidateSessionIds.add(sessionId);
      }
    }
    const knownIdentityIds = new Set(
      allRawRows.flatMap((row) => [
        String(row.deduplication_key),
        String(row.event_id),
      ]),
    );
    const parserEnvelopes = new Map<number, CaptureEnvelope>();
    for (const row of allParserRows) {
      if (row.safe_envelope_json === null) {
        continue;
      }
      const parsed = captureEnvelopeSchema.safeParse(
        JSON.parse(String(row.safe_envelope_json)) as unknown,
      );
      if (parsed.success) {
        parserEnvelopes.set(
          asNumber(row.parser_error_id),
          parsed.data,
        );
        knownIdentityIds.add(parsed.data.deduplicationKey);
        knownIdentityIds.add(parsed.data.event.eventId);
      }
    }
    const referenceIdentifiers = new Set(
      sourceIds,
    );
    const selectedRawKeys = new Set<string>();
    const selectedParserIds = new Set<number>();
    let changed: boolean;
    do {
      changed = false;
      for (const row of allRawRows) {
        const deduplicationKey = String(row.deduplication_key);
        if (selectedRawKeys.has(deduplicationKey)) {
          continue;
        }
        const eventId = String(row.event_id);
        const sessionId =
          row.session_id === null
            ? undefined
            : String(row.session_id);
        const envelope = captureEnvelopeSchema.parse(
          JSON.parse(String(row.safe_envelope_json)) as unknown,
        );
        const directlySelected =
          (
            targetType === "source" &&
            (
              deduplicationKey === targetId ||
              eventId === targetId
            )
          ) ||
          (
            targetType === "session" &&
            sessionId === targetId
          ) ||
          (
            targetType === "episode" &&
            (
              sourceIds.has(eventId) ||
              (
                sessionId !== undefined &&
                targetSessionIds.has(sessionId)
              )
            )
          );
        if (
          !directlySelected &&
          !(
            envelope.event.parentEventId !== undefined &&
            referenceIdentifiers.has(
              envelope.event.parentEventId,
            )
          )
        ) {
          continue;
        }
        selectedRawKeys.add(deduplicationKey);
        sourceIds.add(deduplicationKey);
        sourceIds.add(eventId);
        referenceIdentifiers.add(deduplicationKey);
        referenceIdentifiers.add(eventId);
        if (sessionId !== undefined) {
          candidateSessionIds.add(sessionId);
        }
        changed = true;
      }
      for (const row of allParserRows) {
        const parserErrorId = asNumber(row.parser_error_id);
        if (selectedParserIds.has(parserErrorId)) {
          continue;
        }
        const envelope = parserEnvelopes.get(parserErrorId);
        const deduplicationKey =
          row.deduplication_key === null
            ? undefined
            : String(row.deduplication_key);
        const directlySelected =
          (
            targetType === "source" &&
            (
              (
                deduplicationKey !== undefined &&
                sourceIds.has(deduplicationKey)
              ) ||
              (
                envelope !== undefined &&
                sourceIds.has(envelope.event.eventId)
              )
            )
          ) ||
          (
            targetType === "session" &&
            envelope?.event.sessionId === targetId
          ) ||
          (
            targetType === "episode" &&
            envelope !== undefined &&
            (
              sourceIds.has(envelope.event.eventId) ||
              (
                envelope.event.sessionId !== undefined &&
                targetSessionIds.has(
                  envelope.event.sessionId,
                )
              )
            )
          );
        if (
          !directlySelected &&
          (
            envelope === undefined ||
            envelope.event.parentEventId === undefined ||
            !referenceIdentifiers.has(
              envelope.event.parentEventId,
            )
          )
        ) {
          continue;
        }
        selectedParserIds.add(parserErrorId);
        dependentIds.add(String(row.queue_item_id));
        if (deduplicationKey !== undefined) {
          sourceIds.add(deduplicationKey);
          referenceIdentifiers.add(deduplicationKey);
        }
        if (envelope !== undefined) {
          sourceIds.add(envelope.event.eventId);
          sourceIds.add(envelope.deduplicationKey);
          referenceIdentifiers.add(envelope.event.eventId);
          referenceIdentifiers.add(envelope.deduplicationKey);
          if (envelope.event.sessionId !== undefined) {
            candidateSessionIds.add(envelope.event.sessionId);
          }
        }
        changed = true;
      }
    } while (changed);
    const deduplicationKeys = [...selectedRawKeys].sort();
    const oldEpisodes = this.workEpisodes();
    const selectedEventIds = new Set(
      allRawRows
        .filter((row) =>
          selectedRawKeys.has(String(row.deduplication_key)),
        )
        .map((row) => String(row.event_id)),
    );
    for (const episode of oldEpisodes) {
      if (
        (
          targetType === "episode" &&
          episode.episodeId === targetId
        ) ||
        episode.sourceEventIds.some((eventId) =>
          selectedEventIds.has(eventId),
        ) ||
        (
          targetType === "session" &&
          episode.sessionIds.includes(targetId)
        )
      ) {
        dependencySeedIds.add(episode.episodeId);
      }
    }
    operation = deletionOperationSchema.parse({
      ...operation,
      plannedAffectedSessionIds: [
        ...targetSessionIds,
      ].sort(),
      plannedDependentIds: [
        ...dependentIds,
      ].sort(),
      plannedDependencySeedIds: [
        ...dependencySeedIds,
      ].sort(),
      plannedSourceIds: [
        ...sourceIds,
      ].sort(),
    });
    this.#writeDeletionOperation(operation);
    const oldAssociations = this.episodeAssociations();

    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      this.#assertNoRestoreBarrier();
      if (targetType === "knowledge") {
        this.#database
          .prepare(
            "DELETE FROM knowledge_candidates WHERE knowledge_id = ?",
          )
          .run(targetId);
      }
      if (deduplicationKeys.length > 0) {
        const parameters = placeholders(deduplicationKeys.length);
        this.#database
          .prepare(
            `DELETE FROM parser_errors
              WHERE deduplication_key IN (${parameters})`,
          )
          .run(...deduplicationKeys);
        this.#database
          .prepare(
            `DELETE FROM queue_processing
              WHERE deduplication_key IN (${parameters})`,
          )
          .run(...deduplicationKeys);
        this.#database
          .prepare(
            `DELETE FROM raw_events
              WHERE deduplication_key IN (${parameters})`,
          )
          .run(...deduplicationKeys);
      }
      if (selectedParserIds.size > 0) {
        const parserIds = [...selectedParserIds];
        const parserQueueItemIds = allParserRows
          .filter((row) =>
            selectedParserIds.has(asNumber(row.parser_error_id)),
          )
          .map((row) => String(row.queue_item_id));
        if (parserQueueItemIds.length > 0) {
          this.#database
            .prepare(
              `DELETE FROM queue_processing
                WHERE queue_item_id IN (${placeholders(
                  parserQueueItemIds.length,
                )})`,
            )
            .run(...parserQueueItemIds);
        }
        this.#database
          .prepare(
            `DELETE FROM parser_errors
              WHERE parser_error_id IN (${placeholders(
                parserIds.length,
              )})`,
          )
          .run(...parserIds);
      }
      const removedSessionIds = new Set(
        [...candidateSessionIds].filter((sessionId) => {
          const row = this.#database
            .prepare(
              `SELECT COUNT(*) AS count
                 FROM raw_events
                WHERE session_id = ?`,
            )
            .get(sessionId) as Readonly<Record<string, unknown>>;
          return asNumber(row.count) === 0;
        }),
      );
      for (const episode of oldEpisodes) {
        if (
          (
            targetType === "episode" &&
            episode.episodeId === targetId
          ) ||
          episode.sessionIds.some((sessionId) =>
            removedSessionIds.has(sessionId),
          )
        ) {
          dependentIds.add(episode.episodeId);
          this.#database
            .prepare(
              "DELETE FROM work_episodes WHERE episode_id = ?",
            )
            .run(episode.episodeId);
        }
      }
      for (const association of oldAssociations) {
        if (
          removedSessionIds.has(association.leftSessionId) ||
          removedSessionIds.has(association.rightSessionId)
        ) {
          dependentIds.add(association.associationId);
          this.#database
            .prepare(
              "DELETE FROM evidence_links WHERE link_id = ?",
            )
            .run(association.associationId);
        }
      }
      const dependencyReferences: TypedDeletionReferences = {
        deduplication: new Set(
          [...sourceIds].filter((id) =>
            /^[a-f0-9]{64}$/iu.test(id),
          ),
        ),
        episode: new Set(dependencySeedIds),
        event: new Set(
          [...sourceIds].filter((id) =>
            /^event-[a-f0-9]{64}$/iu.test(id),
          ),
        ),
        record: new Set(dependentIds),
        session: new Set(removedSessionIds),
      };
      const affectedKnowledgeIds = new Set<string>();
      let deletedInPass: number;
      do {
        deletedInPass =
          deleteIdentityRows(
            this.#database,
            dependencyReferences,
            dependentIds,
          ) +
          deleteEvidenceLinkRows(
            this.#database,
            dependencyReferences,
            dependentIds,
            dependencySeedIds,
          ) +
          deleteRebuildableProjectionRows(
            this.#database,
            "branch_contexts",
            "branch_context_id",
            "body_json",
            dependencyReferences,
          ) +
          deleteDependentRows(
            this.#database,
            "correction_keys",
            "correction_key_id",
            "body_json",
            dependencyReferences,
            dependentIds,
          ) +
          deleteDependentRows(
            this.#database,
            "correction_opportunities",
            "opportunity_id",
            "body_json",
            dependencyReferences,
            dependentIds,
          ) +
          (
            targetType === "knowledge"
              ? 0
              : deleteDependentRows(
                  this.#database,
                  "knowledge_candidates",
                  "knowledge_id",
                  "body_json",
                  dependencyReferences,
                  dependentIds,
                )
          ) +
          deleteDependentRows(
            this.#database,
            "process_claims",
            "claim_id",
            "body_json",
            dependencyReferences,
            dependentIds,
          ) +
          deleteFeedbackRows(
            this.#database,
            dependencyReferences,
            dependentIds,
            affectedKnowledgeIds,
          ) +
          deleteSessionMuteRows(
            this.#database,
            dependencyReferences,
          ) +
          deleteDependentRows(
            this.#database,
            "context_use_records",
            "request_id",
            "body_json",
            dependencyReferences,
            dependentIds,
          ) +
          deleteDependentRows(
            this.#database,
            "metrics",
            "metric_id",
            "dimensions_json",
            dependencyReferences,
            dependentIds,
          );
      } while (deletedInPass > 0);
      if (targetType === "knowledge") {
        const timestamp = operation.requestedAt;
        const rows = this.#database
          .prepare(
            `SELECT body_json
               FROM knowledge_candidates
              ORDER BY knowledge_id`,
          )
          .all() as readonly Readonly<Record<string, unknown>>[];
        for (const row of rows) {
          const candidate = knowledgeCandidateSchema.parse(
            JSON.parse(String(row.body_json)) as unknown,
          );
          if (
            candidate.supersedes !== targetId &&
            !candidate.conflictsWith.includes(targetId)
          ) {
            continue;
          }
          const {
            supersedes,
            ...withoutSupersedes
          } = candidate;
          const updated = knowledgeCandidateSchema.parse({
            ...withoutSupersedes,
            conflictsWith: candidate.conflictsWith.filter(
              (conflict) => conflict !== targetId,
            ),
            expiresAt: timestamp,
            state: "archived",
            ...(supersedes === undefined ||
            supersedes === targetId
              ? {}
              : {
                  supersedes,
                }),
            validatedAt: timestamp,
          });
          this.#database
            .prepare(
              `UPDATE knowledge_candidates
                  SET body_json = ?,
                      source_digest = ?,
                      updated_at = ?
                WHERE knowledge_id = ?`,
            )
            .run(
              JSON.stringify(updated),
              sha256(updated),
              timestamp,
              updated.knowledgeId,
            );
        }
      }
      for (const knowledgeId of affectedKnowledgeIds) {
        const row = this.#database
          .prepare(
            `SELECT body_json
               FROM knowledge_candidates
              WHERE knowledge_id = ?`,
          )
          .get(knowledgeId) as
          | Readonly<Record<string, unknown>>
          | undefined;
        if (row === undefined) {
          continue;
        }
        const candidate = knowledgeCandidateSchema.parse(
          JSON.parse(String(row.body_json)) as unknown,
        );
        const deactivated = knowledgeCandidateSchema.parse({
          ...candidate,
          expiresAt: operation.requestedAt,
          state: "archived",
          validatedAt: operation.requestedAt,
        });
        this.#database
          .prepare(
            `UPDATE knowledge_candidates
                SET body_json = ?,
                    source_digest = ?,
                    updated_at = ?
              WHERE knowledge_id = ?`,
          )
          .run(
            JSON.stringify(deactivated),
            sha256(deactivated),
            operation.requestedAt,
            knowledgeId,
          );
      }
      const planned = deletionOperationSchema.parse({
        ...operation,
        plannedAffectedSessionIds: [
          ...targetSessionIds,
        ].sort(),
        plannedDependentIds: [
          ...dependentIds,
        ].sort(),
        plannedDependencySeedIds: [
          ...dependencySeedIds,
        ].sort(),
        plannedSourceIds: [
          ...sourceIds,
        ].sort(),
      });
      this.#writeDeletionOperation(planned);
      this.#database.exec("COMMIT;");
      return {
        affectedSessionIds: [...targetSessionIds].sort(),
        dependentIds: [...dependentIds].sort(),
        sourceIds: [...sourceIds].sort(),
      };
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  public remainingIdentifiers(
    identifiers: ReadonlySet<string>,
  ): readonly string[] {
    const remaining = new Set<string>();
    const inspect = (id: unknown, body?: unknown): void => {
      const normalizedId = String(id);
      if (identifiers.has(normalizedId)) {
        remaining.add(normalizedId);
      }
      if (body !== undefined) {
        const parsed =
          typeof body === "string"
            ? JSON.parse(body) as unknown
            : body;
        const references: TypedDeletionReferences = {
          deduplication: new Set(),
          episode: new Set(),
          event: new Set(),
          record: new Set(identifiers),
          session: new Set(),
        };
        if (bodyReferences(parsed, references)) {
          for (const identifier of identifiers) {
            remaining.add(identifier);
          }
        }
      }
    };
    for (const row of this.#database
      .prepare(
        `SELECT deduplication_key,
                event_id,
                source_event_id,
                session_id,
                safe_envelope_json
           FROM raw_events`,
      )
      .all() as readonly Readonly<Record<string, unknown>>[]) {
      for (const value of Object.values(row)) {
        if (value !== null && identifiers.has(String(value))) {
          remaining.add(String(value));
        }
      }
      const envelope = captureEnvelopeSchema.parse(
        JSON.parse(String(row.safe_envelope_json)) as unknown,
      );
      if (
        envelope.event.parentEventId !== undefined &&
        identifiers.has(envelope.event.parentEventId)
      ) {
        remaining.add(envelope.event.parentEventId);
      }
    }
    for (const row of this.#database
      .prepare(
        `SELECT parser_error_id,
                queue_item_id,
                deduplication_key,
                safe_envelope_json
           FROM parser_errors`,
      )
      .all() as readonly Readonly<Record<string, unknown>>[]) {
      for (const value of Object.values(row)) {
        if (value !== null && identifiers.has(String(value))) {
          remaining.add(String(value));
        }
      }
      if (row.safe_envelope_json !== null) {
        const parsed = captureEnvelopeSchema.safeParse(
          JSON.parse(String(row.safe_envelope_json)) as unknown,
        );
        if (
          parsed.success &&
          [
            parsed.data.deduplicationKey,
            parsed.data.event.eventId,
            parsed.data.event.sessionId,
            parsed.data.event.parentEventId,
          ].some(
            (identifier) =>
              identifier !== undefined &&
              identifiers.has(identifier),
          )
        ) {
          for (const identifier of [
            parsed.data.deduplicationKey,
            parsed.data.event.eventId,
            parsed.data.event.sessionId,
            parsed.data.event.parentEventId,
          ]) {
            if (
              identifier !== undefined &&
              identifiers.has(identifier)
            ) {
              remaining.add(identifier);
            }
          }
        }
      }
    }
    for (const row of this.#database
      .prepare(
        `SELECT queue_item_id,
                deduplication_key,
                last_error
           FROM queue_processing`,
      )
      .all() as readonly Readonly<Record<string, unknown>>[]) {
      for (const value of Object.values(row)) {
        if (value !== null && identifiers.has(String(value))) {
          remaining.add(String(value));
        }
      }
    }
    for (const row of this.#database
      .prepare(
        `SELECT identity_id, canonical_value
           FROM identities`,
      )
      .all() as readonly Readonly<Record<string, unknown>>[]) {
      for (const value of Object.values(row)) {
        if (identifiers.has(String(value))) {
          remaining.add(String(value));
        }
      }
    }
    for (const row of this.#database
      .prepare(
        `SELECT session_id, feedback_id, target_id
           FROM session_mutes`,
      )
      .all() as readonly Readonly<Record<string, unknown>>[]) {
      for (const value of Object.values(row)) {
        if (identifiers.has(String(value))) {
          remaining.add(String(value));
        }
      }
    }
    for (const [
      table,
      idColumn,
      bodyColumn,
    ] of [
      ["branch_contexts", "branch_context_id", "body_json"],
      ["correction_keys", "correction_key_id", "body_json"],
      [
        "correction_opportunities",
        "opportunity_id",
        "body_json",
      ],
      ["knowledge_candidates", "knowledge_id", "body_json"],
      ["work_episodes", "episode_id", "body_json"],
      ["evidence_links", "link_id", "body_json"],
      ["process_claims", "claim_id", "body_json"],
      ["feedback_events", "feedback_id", "body_json"],
      ["context_use_records", "request_id", "body_json"],
      ["metrics", "metric_id", "dimensions_json"],
    ] as const) {
      for (const row of this.#database
        .prepare(
          `SELECT ${idColumn} AS id, ${bodyColumn} AS body
             FROM ${table}`,
        )
        .all() as readonly Readonly<Record<string, unknown>>[]) {
        inspect(row.id, row.body);
      }
    }
    return [...remaining].sort();
  }

  public remainingDeletionIdentities(
    identities: readonly DeletionPlannedIdentity[],
  ): readonly DeletionPlannedIdentity[] {
    const remaining = new Map<string, DeletionPlannedIdentity>();
    const record = (identity: DeletionPlannedIdentity): void => {
      remaining.set(
        `${identity.identityType}\u0000${identity.identifier}`,
        identity,
      );
    };
    const inspectEnvelope = (envelope: CaptureEnvelope): void => {
      for (const identity of identities) {
        const present =
          identity.identityType === "deduplication"
            ? envelope.deduplicationKey === identity.identifier
            : identity.identityType === "event"
              ? (
                  envelope.event.eventId === identity.identifier ||
                  envelope.event.parentEventId === identity.identifier
                )
              : identity.identityType === "session"
                ? envelope.event.sessionId === identity.identifier
                : false;
        if (present) {
          record(identity);
        }
      }
    };
    for (const envelope of this.episodeSourceEnvelopes()) {
      inspectEnvelope(envelope);
    }
    for (const row of this.#database
      .prepare(
        `SELECT safe_envelope_json
           FROM parser_errors
          WHERE safe_envelope_json IS NOT NULL`,
      )
      .all() as readonly Readonly<Record<string, unknown>>[]) {
      const parsed = captureEnvelopeSchema.safeParse(
        JSON.parse(String(row.safe_envelope_json)) as unknown,
      );
      if (parsed.success) {
        inspectEnvelope(parsed.data);
      }
    }
    for (const episode of this.workEpisodes()) {
      for (const identity of identities) {
        const present =
          identity.identityType === "episode"
            ? episode.episodeId === identity.identifier
            : identity.identityType === "event"
              ? episode.sourceEventIds.includes(identity.identifier)
              : identity.identityType === "session"
                ? episode.sessionIds.includes(identity.identifier)
                : false;
        if (present) {
          record(identity);
        }
      }
    }
    for (const association of this.episodeAssociations()) {
      for (const identity of identities) {
        const present =
          identity.identityType === "event"
            ? association.evidence.some((item) =>
                item.sourceEventIds.includes(identity.identifier),
              )
            : identity.identityType === "session"
              ? (
                  association.leftSessionId === identity.identifier ||
                  association.rightSessionId === identity.identifier
                )
              : false;
        if (present) {
          record(identity);
        }
      }
    }
    for (const correction of this.episodeGroupingCorrections()) {
      for (const identity of identities) {
        if (
          identity.identityType === "session" &&
          correction.sessionIds.includes(identity.identifier)
        ) {
          record(identity);
        }
      }
    }
    for (const row of this.#database
      .prepare(
        `SELECT identity_type, canonical_value
           FROM identities`,
      )
      .all() as readonly Readonly<Record<string, unknown>>[]) {
      const identityType = String(row.identity_type).toLowerCase();
      const canonicalValue = String(row.canonical_value);
      for (const identity of identities) {
        const present =
          identityType.includes("alias")
            ? canonicalValue === identity.identifier
            : identity.identityType === "deduplication"
              ? (
                  identityType.includes("dedup") &&
                  canonicalValue === identity.identifier
                )
              : identity.identityType === "event"
                ? (
                    identityType.includes("event") &&
                    canonicalValue === identity.identifier
                  )
                : identity.identityType === "session"
                  ? (
                      identityType.includes("session") &&
                      canonicalValue === identity.identifier
                    )
                  : identity.identityType === "episode"
                    ? (
                        identityType.includes("episode") &&
                        canonicalValue === identity.identifier
                      )
                    : false;
        if (present) {
          record(identity);
        }
      }
    }
    for (const row of this.#database
      .prepare(
        `SELECT session_id
           FROM session_mutes`,
      )
      .all() as readonly Readonly<Record<string, unknown>>[]) {
      for (const identity of identities) {
        if (
          identity.identityType === "session" &&
          String(row.session_id) === identity.identifier
        ) {
          record(identity);
        }
      }
    }
    return [...remaining.values()].sort(
      (left, right) =>
        left.identityType.localeCompare(right.identityType) ||
        left.identifier.localeCompare(right.identifier),
    );
  }

  public prepareDeletionCompletion(input: {
    readonly deletedDependentCount: number;
    readonly deletedQueueItemCount: number;
    readonly deletedSourceCount: number;
    readonly deletionId: string;
    readonly gateDigest: string;
    readonly propagationEvidenceId: string;
  }): DeletionOperation {
    this.#assertNoRestoreBarrier();
    const current = this.deletionOperation(input.deletionId);
    if (current?.status !== "running") {
      throw new Error(
        `Deletion operation ${input.deletionId} is not active.`,
      );
    }
    const completing = deletionOperationSchema.parse({
      ...current,
      deletedDependentCount: input.deletedDependentCount,
      deletedQueueItemCount: input.deletedQueueItemCount,
      deletedSourceCount: input.deletedSourceCount,
      gateDigest: input.gateDigest,
      propagationEvidenceId: input.propagationEvidenceId,
      status: "completing",
    });
    this.#writeDeletionOperation(completing);
    return completing;
  }

  public completeDeletion(
    deletionId: string,
  ): DeletionOperation {
    this.#assertNoRestoreBarrier();
    const current = this.deletionOperation(deletionId);
    if (
      current?.status !== "completing" ||
      current.gateDigest === undefined ||
      current.propagationEvidenceId === undefined ||
      current.plannedSourceIds === undefined
    ) {
      throw new Error(
        `Deletion operation ${deletionId} is not ready to complete.`,
      );
    }
    const completed = deletionOperationSchema.parse({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      attemptCount: current.attemptCount,
      blockedIdentityDigests: [
        ...new Map(
          [
            ...this.#typedDeletionIdentities(
              current.targetType,
              current.activeTargetId,
              current.plannedSourceIds,
            ),
            ...(
              current.targetType === "session" ||
              current.targetType === "episode"
                ? (
                    current.plannedAffectedSessionIds ?? []
                  ).map((identifier) => ({
                    identifier,
                    identityType: "session" as const,
                  }))
                : []
            ),
            ...(current.plannedQueueIdentities ?? []),
          ].map((identity) => {
            const tombstone = {
              digest: deletionIdentityDigest(
                identity.identityType,
                identity.identifier,
                this.#deletionIdentityKey,
              ),
              identityType: identity.identityType,
            };
            return [
              `${tombstone.identityType}\u0000${tombstone.digest}`,
              tombstone,
            ];
          }),
        ).values(),
      ].sort(
        (left, right) =>
          left.identityType.localeCompare(right.identityType) ||
          left.digest.localeCompare(right.digest),
      ),
      completedAt: this.#now().toISOString(),
      deletedDependentCount: current.deletedDependentCount,
      deletedQueueItemCount: current.deletedQueueItemCount,
      deletedSourceCount: current.deletedSourceCount,
      deletionId: current.deletionId,
      gateDigest: deletionIdentityDigest(
        "gate",
        current.gateDigest,
        this.#deletionIdentityKey,
      ),
      tombstoneKeyVerifier:
        this.#deletionIdentityKeyVerifier(),
      propagationEvidenceId: current.propagationEvidenceId,
      requestedAt: current.requestedAt,
      status: "completed",
      targetDigest: current.targetDigest,
      targetType: current.targetType,
    });
    this.#writeDeletionOperation(completed);
    return completed;
  }

  public deleteQueueArtifacts(
    queueItemIds: readonly string[],
  ): number {
    this.#assertNoRestoreBarrier();
    const ids = [
      ...new Set(
        queueItemIds
          .map((id) => id.trim())
          .filter((id) => id.length > 0),
      ),
    ];
    if (ids.length === 0) {
      return 0;
    }
    const parameters = placeholders(ids.length);
    const parser = this.#database
      .prepare(
        `DELETE FROM parser_errors
          WHERE queue_item_id IN (${parameters})`,
      )
      .run(...ids).changes;
    const processing = this.#database
      .prepare(
        `DELETE FROM queue_processing
          WHERE queue_item_id IN (${parameters})`,
      )
      .run(...ids).changes;
    return Number(parser) + Number(processing);
  }

  public checkpointDeletionQueue(input: {
    readonly deletionId: string;
    readonly identities: readonly DeletionPlannedIdentity[];
    readonly queueItemIds: readonly string[];
  }): DeletionOperation {
    this.#assertNoRestoreBarrier();
    const current = this.deletionOperation(input.deletionId);
    if (current?.status !== "running") {
      throw new Error(
        `Deletion operation ${input.deletionId} is not active.`,
      );
    }
    const updated = deletionOperationSchema.parse({
      ...current,
      plannedQueueItemIds: [
        ...new Set([
          ...(current.plannedQueueItemIds ?? []),
          ...input.queueItemIds,
        ]),
      ].sort(),
      plannedQueueIdentities: [
        ...new Map(
          [
            ...(current.plannedQueueIdentities ?? []),
            ...input.identities,
          ].map((identity) => [
            `${identity.identityType}\u0000${identity.identifier}`,
            identity,
          ]),
        ).values(),
      ].sort(
        (left, right) =>
          left.identityType.localeCompare(right.identityType) ||
          left.identifier.localeCompare(right.identifier),
      ),
      plannedSourceIds: [
        ...new Set([
          ...(current.plannedSourceIds ?? []),
          ...input.identities.map(
            (identity) => identity.identifier,
          ),
        ]),
      ].sort(),
    });
    this.#writeDeletionOperation(updated);
    return updated;
  }

  public failDeletion(
    deletionId: string,
    error: unknown,
  ): DeletionOperation {
    this.#assertNoRestoreBarrier();
    void error;
    const current = this.deletionOperation(deletionId);
    if (current?.status !== "running") {
      throw new Error(
        `Deletion operation ${deletionId} is not active.`,
      );
    }
    const failed = deletionOperationSchema.parse({
      ...current,
      completedAt: this.#now().toISOString(),
      error: "Deletion operation failed.",
      status: "failed",
    });
    this.#writeDeletionOperation(failed);
    return failed;
  }

  public deletionIdentityBlocked(
    identityType: DeletionIdentityType,
    identifier: string,
  ): boolean {
    return this.#deletionIdentitiesBlocked([
      {
        identifier,
        identityType,
      },
    ]);
  }

  #deletionIdentitiesBlocked(
    identities: readonly DeletionPlannedIdentity[],
  ): boolean {
    if (identities.length === 0) {
      return false;
    }
    const tombstones = this.#deletionTombstoneKeys();
    return identities.some((identity) =>
      tombstones.has(this.#deletionIdentityKeyFor(identity)),
    );
  }

  #deletionIdentityKeyFor(
    identity: DeletionPlannedIdentity,
  ): string {
    return `${identity.identityType}\u0000${deletionIdentityDigest(
      identity.identityType,
      identity.identifier,
      this.#deletionIdentityKey,
    )}`;
  }

  #deletionTombstoneKeys(): ReadonlySet<string> {
    const rows = this.#database
      .prepare(
        `SELECT body_json
           FROM deletion_operations
          WHERE status = 'completed'`,
      )
      .all() as readonly Readonly<Record<string, unknown>>[];
    const tombstones = new Set(
      rows.flatMap((row) =>
        deletionOperationSchema
          .parse(JSON.parse(String(row.body_json)) as unknown)
          .blockedIdentityDigests.map(
            (tombstone) =>
              `${tombstone.identityType}\u0000${tombstone.digest}`,
          ),
      ),
    );
    return tombstones;
  }

  #knowledgeDeletionBlocked(knowledgeId: string): boolean {
    const targetDigest = deletionIdentityDigest(
      "target",
      `knowledge:${knowledgeId}`,
      this.#deletionIdentityKey,
    );
    const rows = this.#database
      .prepare(
        `SELECT body_json
           FROM deletion_operations
          WHERE status IN ('running', 'completing', 'completed')`,
      )
      .all() as readonly Readonly<Record<string, unknown>>[];
    return rows.some((row) => {
      const operation = deletionOperationSchema.parse(
        JSON.parse(String(row.body_json)) as unknown,
      );
      return operation.targetType === "knowledge" &&
        operation.targetDigest === targetDigest;
    });
  }

  public ingestQueueItem(
    input: CaptureQueueItem,
  ): CanonicalIngestResult {
    this.#assertNoRestoreBarrier();
    const item = captureQueueItemSchema.parse(input);
    const parsedEnvelope = item.envelope;
    if (this.hasActiveDeletion()) {
      throw new Error(
        "Canonical ingestion is blocked by an active deletion.",
      );
    }
    if (
      this.#captureEnvelopeDeletionBlocked(parsedEnvelope)
    ) {
      return {
        deduplicationKey: parsedEnvelope.deduplicationKey,
        status: "duplicate",
      };
    }
    if (parsedEnvelope.event.sessionId === undefined) {
      const reason = "Capture envelope sessionId is required.";
      const placeholder = captureEnvelopeSchema.parse({
        ...parsedEnvelope,
        event: {
          ...parsedEnvelope.event,
          sessionId: "invalid-session-placeholder",
        },
      });
      const safeRejected = redactCaptureEnvelopeForPersistence(
        placeholder,
      ).envelope;
      const safeRejectedEvent = {
        ...safeRejected.event,
        eventId: parsedEnvelope.event.eventId,
      };
      Reflect.deleteProperty(safeRejectedEvent, "sessionId");
      const safeRejectedEnvelope = captureEnvelopeSchema.parse({
        ...safeRejected,
        deduplicationKey: parsedEnvelope.deduplicationKey,
        event: safeRejectedEvent,
        sourceEventId: parsedEnvelope.sourceEventId,
      });
      const recorded = this.#recordRejected(
        item,
        parsedEnvelope.deduplicationKey,
        "invalid_identity",
        reason,
        JSON.stringify(safeRejectedEnvelope),
      );
      return recorded
        ? {
            status: "rejected",
            deduplicationKey: parsedEnvelope.deduplicationKey,
            reason,
          }
        : {
            status: "duplicate",
            deduplicationKey: parsedEnvelope.deduplicationKey,
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
      const recorded = this.#recordRejected(
        item,
        expectedDeduplicationKey,
        "invalid_identity",
        reason,
        safeEnvelopeJson,
      );
      return recorded
        ? {
            status: "rejected",
            deduplicationKey: expectedDeduplicationKey,
            reason,
          }
        : {
            status: "duplicate",
            deduplicationKey: expectedDeduplicationKey,
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
      this.#assertNoRestoreBarrier();
      if (this.hasActiveDeletion()) {
        throw new Error(
          "Canonical ingestion is blocked by an active deletion.",
        );
      }
      if (
        this.#captureEnvelopeDeletionBlocked(parsedEnvelope)
      ) {
        this.#database.exec("ROLLBACK;");
        return {
          deduplicationKey: parsedEnvelope.deduplicationKey,
          status: "duplicate",
        };
      }
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

  public episodeSourceEnvelopes(): readonly CaptureEnvelope[] {
    const rows = this.#database
      .prepare(
        `SELECT safe_envelope_json
           FROM raw_events
          WHERE parse_status = 'supported'
          ORDER BY event_timestamp, deduplication_key`,
      )
      .all() as readonly Readonly<Record<string, unknown>>[];
    return rows.map((row) =>
      captureEnvelopeSchema.parse(
        JSON.parse(String(row.safe_envelope_json)) as unknown,
      ),
    );
  }

  public replaceWorkEpisodeProjection(input: {
    readonly allowDuringDeletion?: boolean;
    readonly associations: readonly EpisodeAssociation[];
    readonly corrections: readonly EpisodeGroupingCorrection[];
    readonly episodes: readonly WorkEpisode[];
  }): WorkEpisodeProjectionWriteResult {
    this.#assertNoRestoreBarrier();
    const associations = input.associations.map((association) =>
      episodeAssociationSchema.parse(association),
    );
    const episodes = input.episodes.map((episode) =>
      workEpisodeSchema.parse(episode),
    );
    const corrections = input.corrections.map((correction) =>
      episodeGroupingCorrectionSchema.parse(correction),
    );
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      this.#assertNoRestoreBarrier();
      if (
        this.hasActiveDeletion() &&
        input.allowDuringDeletion !== true
      ) {
        throw new Error(
          "Work Episode projection is blocked by an active deletion.",
        );
      }

      const projectionIdentities: DeletionPlannedIdentity[] = [
        ...episodes.flatMap((episode) => [
          {
            identifier: episode.episodeId,
            identityType: "episode" as const,
          },
          ...episode.sessionIds.map((identifier) => ({
            identifier,
            identityType: "session" as const,
          })),
          ...episode.sourceEventIds.map((identifier) => ({
            identifier,
            identityType: "event" as const,
          })),
        ]),
        ...associations.flatMap((association) => [
          {
            identifier: association.leftSessionId,
            identityType: "session" as const,
          },
          {
            identifier: association.rightSessionId,
            identityType: "session" as const,
          },
          ...association.evidence.flatMap(
            (item) =>
              item.sourceEventIds.map((identifier) => ({
                identifier,
                identityType: "event" as const,
              })),
          ),
        ]),
        ...corrections.flatMap((correction) =>
          correction.sessionIds.map((identifier) => ({
            identifier,
            identityType: "session" as const,
          })),
        ),
      ];
      if (
        this.#deletionIdentitiesBlocked(projectionIdentities)
      ) {
        throw new Error(
          "Work Episode projection contains a deleted identity.",
        );
      }
      const existingLinks = this.#database
        .prepare(
          `SELECT link_id, body_json
             FROM evidence_links`,
        )
        .all() as readonly Readonly<Record<string, unknown>>[];
      const removeLink = this.#database.prepare(
        "DELETE FROM evidence_links WHERE link_id = ?",
      );
      for (const row of existingLinks) {
        let body: unknown;
        try {
          body = JSON.parse(String(row.body_json)) as unknown;
        } catch {
          continue;
        }
        if (
          episodeAssociationSchema.safeParse(body).success ||
          episodeGroupingCorrectionSchema.safeParse(body).success
        ) {
          removeLink.run(String(row.link_id));
        }
      }
      this.#database.exec("DELETE FROM work_episodes;");
      const insertAssociation = this.#database.prepare(
        `INSERT INTO evidence_links (
           link_id,
           schema_version,
           body_json,
           source_digest,
           created_at
         ) VALUES (?, ?, ?, ?, ?)`,
      );
      const insertEpisode = this.#database.prepare(
        `INSERT INTO work_episodes (
           episode_id,
           schema_version,
           body_json,
           source_digest,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const association of associations) {
        insertAssociation.run(
          association.associationId,
          association.schemaVersion,
          JSON.stringify(association),
          sha256(association),
          association.createdAt,
        );
      }
      for (const correction of corrections) {
        insertAssociation.run(
          correction.correctionId,
          correction.schemaVersion,
          JSON.stringify(correction),
          sha256(correction),
          correction.timestamp,
        );
      }
      for (const episode of episodes) {
        insertEpisode.run(
          episode.episodeId,
          episode.schemaVersion,
          JSON.stringify(episode),
          sha256(episode),
          episode.startedAt,
          episode.finishedAt ?? episode.startedAt,
        );
      }
      this.#database.exec("COMMIT;");
      return {
        associations: associations.length,
        corrections: corrections.length,
        episodes: episodes.length,
      };
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  public replaceBranchContextProjection(input: {
    readonly allowDuringDeletion?: boolean;
    readonly contexts: readonly BranchContext[];
  }): number {
    this.#assertNoRestoreBarrier();
    const contexts = input.contexts.map((context) =>
      branchContextSchema.parse(context),
    );
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      this.#assertNoRestoreBarrier();
      if (
        this.hasActiveDeletion() &&
        input.allowDuringDeletion !== true
      ) {
        throw new Error(
          "Branch Context projection is blocked by an active deletion.",
        );
      }
      if (
        this.#deletionIdentitiesBlocked(
          contexts.flatMap((context) => [
            ...context.sourceEpisodeIds.map((identifier) => ({
              identifier,
              identityType: "episode" as const,
            })),
            ...context.sourceEventIds.map((identifier) => ({
              identifier,
              identityType: "event" as const,
            })),
          ]),
        )
      ) {
        throw new Error(
          "Branch Context projection contains a deleted identity.",
        );
      }
      this.#database.exec("DELETE FROM branch_contexts;");
      const insert = this.#database.prepare(
        `INSERT INTO branch_contexts (
           branch_context_id,
           repo_id,
           branch,
           head_sha,
           body_json,
           source_digest,
           updated_at,
           expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const context of contexts) {
        insert.run(
          context.branchContextId,
          context.repoId,
          context.branch,
          context.headSha,
          JSON.stringify(context),
          sha256(context),
          context.updatedAt,
          optionalText(context.expiresAt),
        );
      }
      this.#database.exec("COMMIT;");
      return contexts.length;
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  public branchContexts(): readonly BranchContext[] {
    const rows = this.#database
      .prepare(
        `SELECT body_json
           FROM branch_contexts
          ORDER BY repo_id, branch`,
      )
      .all() as readonly Readonly<Record<string, unknown>>[];
    return rows.map((row) =>
      branchContextSchema.parse(
        JSON.parse(String(row.body_json)) as unknown,
      ),
    );
  }

  public branchContextFor(input: {
    readonly branch: string;
    readonly headSha: string;
    readonly now?: Date;
    readonly repoId: string;
  }): BranchContext | undefined {
    const row = this.#database
      .prepare(
        `SELECT body_json
           FROM branch_contexts
          WHERE repo_id = ?
            AND branch = ?`,
      )
      .get(input.repoId, input.branch) as
      | Readonly<Record<string, unknown>>
      | undefined;
    if (row === undefined) {
      return undefined;
    }
    const context = branchContextSchema.parse(
      JSON.parse(String(row.body_json)) as unknown,
    );
    if (
      context.headSha !== input.headSha ||
      (
        context.expiresAt !== undefined &&
        Date.parse(context.expiresAt) <=
          (input.now ?? this.#now()).getTime()
      ) ||
      this.#deletionIdentitiesBlocked([
        ...context.sourceEpisodeIds.map((identifier) => ({
          identifier,
          identityType: "episode" as const,
        })),
        ...context.sourceEventIds.map((identifier) => ({
          identifier,
          identityType: "event" as const,
        })),
      ])
    ) {
      return undefined;
    }
    return context;
  }

  public replaceCorrectionProjection(input: {
    readonly allowDuringDeletion?: boolean;
    readonly correctionKeys: readonly CorrectionKey[];
    readonly opportunities: readonly CorrectionOpportunity[];
  }): CorrectionProjectionWriteResult {
    this.#assertNoRestoreBarrier();
    const correctionKeys = input.correctionKeys.map((key) =>
      correctionKeySchema.parse(key),
    );
    const opportunities = input.opportunities.map((opportunity) =>
      correctionOpportunitySchema.parse(opportunity),
    );
    const correctionKeyIds = new Set(
      correctionKeys.map((key) => key.correctionKeyId),
    );
    const missingKey = opportunities.find(
      (opportunity) =>
        !correctionKeyIds.has(opportunity.correctionKeyId),
    );
    if (missingKey !== undefined) {
      throw new Error(
        `Correction Opportunity ${missingKey.opportunityId} references an unknown Correction Key.`,
      );
    }
    const episodeIds = new Set(
      this.workEpisodes().map((episode) => episode.episodeId),
    );
    const missingEpisode = opportunities.find(
      (opportunity) => !episodeIds.has(opportunity.episodeId),
    );
    if (missingEpisode !== undefined) {
      throw new Error(
        `Correction Opportunity ${missingEpisode.opportunityId} references an unknown Work Episode.`,
      );
    }
    if (
      this.#deletionIdentitiesBlocked([
        ...correctionKeys.flatMap((key) => [
          ...key.sourceCorrectionEventIds.map((identifier) => ({
            identifier,
            identityType: "event" as const,
          })),
          ...key.verificationEvidenceIds.map((identifier) => ({
            identifier,
            identityType: "event" as const,
          })),
        ]),
        ...opportunities.map((opportunity) => ({
          identifier: opportunity.episodeId,
          identityType: "episode" as const,
        })),
      ])
    ) {
      throw new Error(
        "Correction projection contains a deleted identity.",
      );
    }
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      this.#assertNoRestoreBarrier();
      if (
        this.hasActiveDeletion() &&
        input.allowDuringDeletion !== true
      ) {
        throw new Error(
          "Correction projection is blocked by an active deletion.",
        );
      }
      this.#database.exec("DELETE FROM correction_opportunities;");
      this.#database.exec("DELETE FROM correction_keys;");
      const insertKey = this.#database.prepare(
        `INSERT INTO correction_keys (
           correction_key_id,
           schema_version,
           scope,
           scope_id,
           body_json,
           source_digest,
           created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const key of correctionKeys) {
        insertKey.run(
          key.correctionKeyId,
          key.schemaVersion,
          key.scope,
          optionalText(key.scopeId),
          JSON.stringify(key),
          sha256(key),
          key.createdAt,
        );
      }
      const insertOpportunity = this.#database.prepare(
        `INSERT INTO correction_opportunities (
           opportunity_id,
           schema_version,
           correction_key_id,
           episode_id,
           applicable,
           body_json,
           source_digest,
           created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const opportunity of opportunities) {
        insertOpportunity.run(
          opportunity.opportunityId,
          opportunity.schemaVersion,
          opportunity.correctionKeyId,
          opportunity.episodeId,
          opportunity.applicable ? 1 : 0,
          JSON.stringify(opportunity),
          sha256(opportunity),
          opportunity.createdAt,
        );
      }
      this.#database.exec("COMMIT;");
      return {
        correctionKeys: correctionKeys.length,
        opportunities: opportunities.length,
      };
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  public correctionKeys(): readonly CorrectionKey[] {
    const rows = this.#database
      .prepare(
        `SELECT body_json
           FROM correction_keys
          ORDER BY correction_key_id`,
      )
      .all() as readonly Readonly<Record<string, unknown>>[];
    return rows.map((row) =>
      correctionKeySchema.parse(
        JSON.parse(String(row.body_json)) as unknown,
      ),
    );
  }

  public correctionSourceEventIds(): ReadonlySet<string> {
    const rows = this.#database
      .prepare(
        `SELECT event_id
           FROM raw_events
          WHERE event_type = 'user.corrected'
            AND parse_status = 'supported'
          ORDER BY event_id`,
      )
      .all() as readonly Readonly<Record<string, unknown>>[];
    return new Set(rows.map((row) => String(row.event_id)));
  }

  public correctionOpportunities(
    correctionKeyId?: string,
  ): readonly CorrectionOpportunity[] {
    return (
      this.#database
        .prepare(
          `SELECT body_json
             FROM correction_opportunities
            ORDER BY created_at, opportunity_id`,
        )
        .all() as readonly Readonly<Record<string, unknown>>[]
    )
      .map((row) =>
        correctionOpportunitySchema.parse(
          JSON.parse(String(row.body_json)) as unknown,
        ),
      )
      .filter(
        (opportunity) =>
          correctionKeyId === undefined ||
          opportunity.correctionKeyId === correctionKeyId,
      );
  }

  public upsertKnowledgeCandidates(
    input: readonly KnowledgeCandidate[],
  ): number {
    this.#assertNoRestoreBarrier();
    const candidates = input.map(normalizedKnowledgeCandidate);
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      this.#assertNoRestoreBarrier();
      if (this.hasActiveDeletion()) {
        throw new Error(
          "Knowledge persistence is blocked by an active deletion.",
        );
      }
      if (
        this.knowledgeCandidatesWithDeletedSources(candidates)
          .size > 0
      ) {
        throw new Error(
          "Knowledge candidate contains a deleted identity.",
        );
      }
      const forgotten = candidates.find((candidate) =>
        this.#knowledgeDeletionBlocked(candidate.knowledgeId),
      );
      if (forgotten !== undefined) {
        throw new Error(
          `Knowledge ${forgotten.knowledgeId} was forgotten and cannot be restored.`,
        );
      }
      const sourceEpisodeIds = new Set(
        candidates.flatMap(
          (candidate) => candidate.sourceEpisodeIds,
        ),
      );
      if (sourceEpisodeIds.size > 0) {
        const ids = [...sourceEpisodeIds];
        const existing = new Set(
          (
            this.#database
              .prepare(
                `SELECT episode_id
                   FROM work_episodes
                  WHERE episode_id IN (${placeholders(ids.length)})`,
              )
              .all(...ids) as readonly Readonly<
              Record<string, unknown>
            >[]
          ).map((row) => String(row.episode_id)),
        );
        const missing = ids.find((id) => !existing.has(id));
        if (missing !== undefined) {
          throw new Error(
            `Knowledge candidate references missing source Episode ${missing}.`,
          );
        }
      }
      const upsert = this.#database.prepare(
        `INSERT INTO knowledge_candidates (
           knowledge_id,
           schema_version,
           body_json,
           source_digest,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(knowledge_id) DO UPDATE SET
           schema_version = excluded.schema_version,
           body_json = excluded.body_json,
           source_digest = excluded.source_digest,
           updated_at = excluded.updated_at`,
      );
      for (const candidate of candidates) {
        upsert.run(
          candidate.knowledgeId,
          candidate.schemaVersion,
          JSON.stringify(candidate),
          sha256(candidate),
          candidate.createdAt,
          candidate.validatedAt ?? candidate.createdAt,
        );
      }
      this.#database.exec("COMMIT;");
      return candidates.length;
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  public replaceCorrectionKnowledgeCandidates(input: {
    readonly allowDuringDeletion?: boolean;
    readonly candidates: readonly KnowledgeCandidate[];
  }): number {
    this.#assertNoRestoreBarrier();
    const candidates = input.candidates.map(
      normalizedKnowledgeCandidate,
    );
    const invalid = candidates.find(
      (candidate) =>
        !candidate.knowledgeId.startsWith(
          "correction-knowledge-",
        ) ||
        !candidate.topicKey.startsWith("correction:"),
    );
    if (invalid !== undefined) {
      throw new Error(
        "Correction Knowledge projection received a non-correction candidate.",
      );
    }
    if (
      this.knowledgeCandidatesWithDeletedSources(candidates)
        .size > 0
    ) {
      throw new Error(
        "Correction Knowledge contains a deleted identity.",
      );
    }
    const forgotten = candidates.find((candidate) =>
      this.#knowledgeDeletionBlocked(candidate.knowledgeId),
    );
    if (forgotten !== undefined) {
      throw new Error(
        `Knowledge ${forgotten.knowledgeId} was forgotten and cannot be restored.`,
      );
    }
    const sourceEpisodeIds = new Set(
      candidates.flatMap(
        (candidate) => candidate.sourceEpisodeIds,
      ),
    );
    if (sourceEpisodeIds.size > 0) {
      const ids = [...sourceEpisodeIds];
      const existing = new Set(
        (
          this.#database
            .prepare(
              `SELECT episode_id
                 FROM work_episodes
                WHERE episode_id IN (${placeholders(ids.length)})`,
            )
            .all(...ids) as readonly Readonly<
            Record<string, unknown>
          >[]
        ).map((row) => String(row.episode_id)),
      );
      const missing = ids.find((id) => !existing.has(id));
      if (missing !== undefined) {
        throw new Error(
          `Correction Knowledge references missing source Episode ${missing}.`,
        );
      }
    }
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      this.#assertNoRestoreBarrier();
      if (
        this.hasActiveDeletion() &&
        input.allowDuringDeletion !== true
      ) {
        throw new Error(
          "Correction Knowledge projection is blocked by an active deletion.",
        );
      }
      const selected = new Set(
        candidates.map((candidate) => candidate.knowledgeId),
      );
      const existing = (
        this.#database
          .prepare(
            `SELECT knowledge_id
               FROM knowledge_candidates
              WHERE knowledge_id LIKE 'correction-knowledge-%'`,
          )
          .all() as readonly Readonly<Record<string, unknown>>[]
      ).map((row) => String(row.knowledge_id));
      const removed = existing.filter((id) => !selected.has(id));
      if (removed.length > 0) {
        this.#database
          .prepare(
            `DELETE FROM knowledge_candidates
              WHERE knowledge_id IN (${placeholders(removed.length)})`,
          )
          .run(...removed);
      }
      const upsert = this.#database.prepare(
        `INSERT INTO knowledge_candidates (
           knowledge_id,
           schema_version,
           body_json,
           source_digest,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(knowledge_id) DO UPDATE SET
           schema_version = excluded.schema_version,
           body_json = excluded.body_json,
           source_digest = excluded.source_digest,
           updated_at = excluded.updated_at`,
      );
      for (const candidate of candidates) {
        upsert.run(
          candidate.knowledgeId,
          candidate.schemaVersion,
          JSON.stringify(candidate),
          sha256(candidate),
          candidate.createdAt,
          candidate.validatedAt ?? candidate.createdAt,
        );
      }
      this.#database.exec("COMMIT;");
      return candidates.length;
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  public knowledgeDeletionBlocked(knowledgeId: string): boolean {
    return this.#knowledgeDeletionBlocked(knowledgeId.trim());
  }

  public removeKnowledgeCandidates(
    ids: readonly string[],
  ): number {
    this.#assertNoRestoreBarrier();
    const selected = [
      ...new Set(
        ids
          .map((id) => id.trim())
          .filter((id) => id.length > 0),
      ),
    ];
    if (selected.length === 0) {
      return 0;
    }
    return Number(
      this.#database
        .prepare(
          `DELETE FROM knowledge_candidates
            WHERE knowledge_id IN (${placeholders(
              selected.length,
            )})`,
        )
        .run(...selected).changes,
    );
  }

  public knowledgeCandidates(
    ids?: readonly string[],
  ): readonly KnowledgeCandidate[] {
    const selected =
      ids === undefined
        ? undefined
        : [
            ...new Set(
              ids
                .map((id) => id.trim())
                .filter((id) => id.length > 0),
            ),
          ];
    if (selected !== undefined && selected.length === 0) {
      return [];
    }
    const rows = this.#database
      .prepare(
        selected === undefined
          ? `SELECT body_json
               FROM knowledge_candidates
              ORDER BY created_at, knowledge_id`
          : `SELECT body_json
               FROM knowledge_candidates
              WHERE knowledge_id IN (${placeholders(
                selected.length,
              )})
              ORDER BY created_at, knowledge_id`,
      )
      .all(...(selected ?? [])) as readonly Readonly<
      Record<string, unknown>
    >[];
    return rows.map((row) =>
      knowledgeCandidateSchema.parse(
        JSON.parse(String(row.body_json)) as unknown,
      ),
    );
  }

  public appendContextUseRecord(
    input: ContextUseRecord,
  ): boolean {
    this.#assertNoRestoreBarrier();
    const record = contextUseRecordSchema.parse(input);
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      this.#assertNoRestoreBarrier();
      if (this.hasActiveDeletion()) {
        throw new Error(
          "Context use persistence is blocked by an active deletion.",
        );
      }
      const result = this.#database
        .prepare(
          `INSERT OR IGNORE INTO context_use_records (
             request_id,
             schema_version,
             session_id,
             body_json,
             source_digest,
             created_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.requestId,
          record.schemaVersion,
          record.sessionId,
          JSON.stringify(record),
          sha256(record),
          record.createdAt,
        );
      this.#database.exec("COMMIT;");
      return Number(result.changes) === 1;
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  public contextUseRecords(
    sessionId?: string,
  ): readonly ContextUseRecord[] {
    const normalizedSessionId = sessionId?.trim();
    const rows = this.#database
      .prepare(
        normalizedSessionId === undefined
          ? `SELECT body_json
               FROM context_use_records
              ORDER BY created_at, request_id`
          : `SELECT body_json
               FROM context_use_records
              WHERE session_id = ?
              ORDER BY created_at, request_id`,
      )
      .all(...(
        normalizedSessionId === undefined
          ? []
          : [
              normalizedSessionId,
            ]
      )) as readonly Readonly<Record<string, unknown>>[];
    return rows.map((row) =>
      contextUseRecordSchema.parse(
        JSON.parse(String(row.body_json)) as unknown,
      ),
    );
  }

  public recordKnowledgeFeedback(input: {
    readonly contextRequestId?: string;
    readonly event: FeedbackEvent;
    readonly updateCandidate?: (
      candidate: KnowledgeCandidate,
    ) => KnowledgeCandidate;
    readonly updateContextUseRecord?: (
      record: ContextUseRecord,
    ) => ContextUseRecord;
  }): {
    readonly candidate: KnowledgeCandidate;
    readonly recorded: boolean;
  } {
    this.#assertNoRestoreBarrier();
    const event = feedbackEventSchema.parse(input.event);
    if (event.targetType !== "knowledge") {
      throw new Error(
        "Knowledge feedback must target Knowledge.",
      );
    }
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      this.#assertNoRestoreBarrier();
      if (this.hasActiveDeletion()) {
        throw new Error(
          "Knowledge feedback is blocked by an active deletion.",
        );
      }
      const existingRow = this.#database
        .prepare(
          `SELECT body_json
             FROM knowledge_candidates
            WHERE knowledge_id = ?`,
        )
        .get(event.targetId) as
        | Readonly<Record<string, unknown>>
        | undefined;
      if (existingRow === undefined) {
        throw new Error(
          `Knowledge feedback target ${event.targetId} does not exist.`,
        );
      }
      const existing = normalizedKnowledgeCandidate(
        JSON.parse(String(existingRow.body_json)) as KnowledgeCandidate,
      );
      const inserted = this.#database
        .prepare(
          `INSERT OR IGNORE INTO feedback_events (
             feedback_id,
             schema_version,
             body_json,
             source_digest,
             created_at
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          event.feedbackId,
          event.schemaVersion,
          JSON.stringify(event),
          sha256(event),
          event.timestamp,
        );
      if (Number(inserted.changes) === 0) {
        const existingEventRow = this.#database
          .prepare(
            `SELECT body_json
               FROM feedback_events
              WHERE feedback_id = ?`,
          )
          .get(event.feedbackId) as Readonly<Record<string, unknown>>;
        const existingEvent = feedbackEventSchema.parse(
          JSON.parse(String(existingEventRow.body_json)) as unknown,
        );
        if (
          feedbackIntentDigest(existingEvent) !==
          feedbackIntentDigest(event)
        ) {
          throw new Error(
            "Feedback ID already exists with different content.",
          );
        }
        if (existingEvent.kind === "mute_session") {
          this.#upsertSessionMute(existingEvent);
        }
        this.#database.exec("COMMIT;");
        return {
          candidate: existing,
          recorded: false,
        };
      }
      if (event.kind === "mute_session") {
        this.#upsertSessionMute(event);
      }
      const candidate =
        input.updateCandidate === undefined
          ? existing
          : normalizedKnowledgeCandidate(
              input.updateCandidate(existing),
            );
      if (
        candidate.knowledgeId !== event.targetId ||
        JSON.stringify(candidate.sourceEpisodeIds) !==
          JSON.stringify(existing.sourceEpisodeIds) ||
        JSON.stringify(candidate.sourceEvidenceIds) !==
          JSON.stringify(existing.sourceEvidenceIds)
      ) {
        throw new Error(
          "Knowledge feedback cannot replace identity or provenance.",
        );
      }
      if (input.updateCandidate !== undefined) {
        this.#database
          .prepare(
            `UPDATE knowledge_candidates
                SET schema_version = ?,
                    body_json = ?,
                    source_digest = ?,
                    updated_at = ?
              WHERE knowledge_id = ?`,
          )
          .run(
            candidate.schemaVersion,
            JSON.stringify(candidate),
            sha256(candidate),
            candidate.validatedAt ?? event.timestamp,
            candidate.knowledgeId,
          );
      }
      if (input.updateContextUseRecord !== undefined) {
        const contextRow = this.#database
          .prepare(
            `SELECT body_json
               FROM context_use_records
              WHERE request_id = ?`,
          )
          .get(input.contextRequestId ?? event.evidenceRef) as
          | Readonly<Record<string, unknown>>
          | undefined;
        if (contextRow === undefined) {
          throw new Error(
            "Knowledge feedback context request does not exist.",
          );
        }
        const contextUseRecord = contextUseRecordSchema.parse(
          input.updateContextUseRecord(
            contextUseRecordSchema.parse(
              JSON.parse(String(contextRow.body_json)) as unknown,
            ),
          ),
        );
        const updated = this.#database
          .prepare(
            `UPDATE context_use_records
                SET body_json = ?,
                    source_digest = ?
              WHERE request_id = ?
                AND session_id = ?`,
          )
          .run(
            JSON.stringify(contextUseRecord),
            sha256(contextUseRecord),
            contextUseRecord.requestId,
            contextUseRecord.sessionId,
          );
        if (Number(updated.changes) !== 1) {
          throw new Error(
            "Knowledge feedback context request does not exist.",
          );
        }
      }
      this.#database.exec("COMMIT;");
      return {
        candidate,
        recorded: true,
      };
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  public feedbackEvents(
    targetId?: string,
  ): readonly FeedbackEvent[] {
    const normalizedTargetId = targetId?.trim();
    const rows = this.#database
      .prepare(
        normalizedTargetId === undefined
          ? `SELECT body_json
               FROM feedback_events
              ORDER BY created_at, feedback_id`
          : `SELECT body_json
               FROM feedback_events
              WHERE json_extract(body_json, '$.targetId') = ?
              ORDER BY created_at, feedback_id`,
      )
      .all(...(
        normalizedTargetId === undefined
          ? []
          : [
              normalizedTargetId,
            ]
      )) as readonly Readonly<Record<string, unknown>>[];
    return rows.map((row) =>
      feedbackEventSchema.parse(
        JSON.parse(String(row.body_json)) as unknown,
      ),
    );
  }

  public sessionMuted(sessionId: string): boolean {
    const normalizedSessionId = sessionId.trim();
    if (normalizedSessionId.length === 0) {
      return false;
    }
    return this.#database
      .prepare(
        `SELECT 1
           FROM session_mutes
          WHERE session_id = ?`,
      )
      .get(normalizedSessionId) !== undefined;
  }

  #upsertSessionMute(event: FeedbackEvent): void {
    this.#database
      .prepare(
        `INSERT INTO session_mutes (
           feedback_id,
           session_id,
           target_id,
           created_at
         ) VALUES (?, ?, ?, ?)
         ON CONFLICT(feedback_id) DO UPDATE SET
           target_id = excluded.target_id,
           session_id = excluded.session_id,
           created_at = excluded.created_at`,
      )
      .run(
        event.feedbackId,
        event.evidenceRef,
        event.targetId,
        event.timestamp,
      );
  }

  public knowledgeCandidatesWithDeletedSources(
    input: readonly KnowledgeCandidate[],
  ): ReadonlySet<string> {
    const candidates = input.map((candidate) =>
      knowledgeCandidateSchema.parse(candidate),
    );
    const tombstones = this.#deletionTombstoneKeys();
    return new Set(
      candidates.flatMap((candidate) => {
        const evidenceIdentities: DeletionPlannedIdentity[] = [];
        for (const identifier of candidate.sourceEvidenceIds) {
          if (/^event-[a-f0-9]{64}$/iu.test(identifier)) {
            evidenceIdentities.push({
              identifier: identifier.toLowerCase(),
              identityType: "event",
            });
          } else if (/^[a-f0-9]{64}$/iu.test(identifier)) {
            evidenceIdentities.push({
              identifier: identifier.toLowerCase(),
              identityType: "deduplication",
            });
          }
        }
        const identities: DeletionPlannedIdentity[] = [
          ...candidate.sourceEpisodeIds.map((identifier) => ({
            identifier,
            identityType: "episode" as const,
          })),
          ...evidenceIdentities,
        ];
        return identities.some((identity) =>
          tombstones.has(this.#deletionIdentityKeyFor(identity)),
        )
          ? [candidate.knowledgeId]
          : [];
      }),
    );
  }

  public knowledgeCandidatesWithUnavailableSources(
    input: readonly KnowledgeCandidate[],
  ): ReadonlySet<string> {
    const candidates = input.map((candidate) =>
      knowledgeCandidateSchema.parse(candidate),
    );
    const unavailable = new Set(
      this.knowledgeCandidatesWithDeletedSources(candidates),
    );
    const sourceEpisodeIds = [
      ...new Set(
        candidates.flatMap(
          (candidate) => candidate.sourceEpisodeIds,
        ),
      ),
    ];
    if (sourceEpisodeIds.length === 0) {
      return unavailable;
    }
    const existing = new Set(
      (
        this.#database
          .prepare(
            `SELECT episode_id
               FROM work_episodes
              WHERE episode_id IN (${placeholders(
                sourceEpisodeIds.length,
              )})`,
          )
          .all(...sourceEpisodeIds) as readonly Readonly<
          Record<string, unknown>
        >[]
      ).map((row) => String(row.episode_id)),
    );
    for (const candidate of candidates) {
      if (
        candidate.sourceEpisodeIds.some(
          (episodeId) => !existing.has(episodeId),
        )
      ) {
        unavailable.add(candidate.knowledgeId);
      }
    }
    return unavailable;
  }

  public episodeAssociations(): readonly EpisodeAssociation[] {
    const rows = this.#database
      .prepare(
        `SELECT body_json
           FROM evidence_links
          ORDER BY link_id`,
      )
      .all() as readonly Readonly<Record<string, unknown>>[];
    return rows.flatMap((row) => {
      let body: unknown;
      try {
        body = JSON.parse(String(row.body_json)) as unknown;
      } catch {
        return [];
      }
      const parsed = episodeAssociationSchema.safeParse(body);
      return parsed.success ? [parsed.data] : [];
    });
  }

  public episodeGroupingCorrections():
  readonly EpisodeGroupingCorrection[] {
    const rows = this.#database
      .prepare(
        `SELECT body_json
           FROM evidence_links
          ORDER BY created_at, link_id`,
      )
      .all() as readonly Readonly<Record<string, unknown>>[];
    return rows.flatMap((row) => {
      let body: unknown;
      try {
        body = JSON.parse(String(row.body_json)) as unknown;
      } catch {
        return [];
      }
      const parsed = episodeGroupingCorrectionSchema.safeParse(body);
      return parsed.success ? [parsed.data] : [];
    });
  }

  public workEpisodes(): readonly WorkEpisode[] {
    const rows = this.#database
      .prepare(
        `SELECT body_json
           FROM work_episodes
          ORDER BY created_at, episode_id`,
      )
      .all() as readonly Readonly<Record<string, unknown>>[];
    return rows
      .map((row) =>
        workEpisodeSchema.parse(
          JSON.parse(String(row.body_json)) as unknown,
        ),
      )
      .sort(
        (left, right) =>
          Date.parse(left.startedAt) - Date.parse(right.startedAt) ||
          left.episodeId.localeCompare(right.episodeId),
      );
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

  #typedDeletionIdentities(
    targetType: DeletionTargetType,
    targetId: string | undefined,
    identifiers: readonly string[],
  ): readonly DeletionPlannedIdentity[] {
    const typed = new Map<string, DeletionPlannedIdentity>();
    const add = (
        identityType: DeletionIdentityType,
        identifier: string,
    ): void => {
        typed.set(
          `${identityType}\u0000${identifier}`,
          {
            identifier,
            identityType,
          },
        );
    };
    if (targetId !== undefined) {
        if (targetType === "episode") {
          add("episode", targetId);
        } else if (targetType === "session") {
          add("session", targetId);
        }
    }
    for (const identifier of identifiers) {
        if (/^event-[a-f0-9]{64}$/iu.test(identifier)) {
          add("event", identifier.toLowerCase());
        } else if (/^[a-f0-9]{64}$/iu.test(identifier)) {
          add("deduplication", identifier.toLowerCase());
        }
    }
    return [...typed.values()];
  }

  #validateDeletionIdentityKey(): void {
    const expectedVerifier = this.#deletionIdentityKeyVerifier();
    const rows = this.#database
      .prepare(
        `SELECT body_json
           FROM deletion_operations`,
      )
      .all() as readonly Readonly<Record<string, unknown>>[];
    for (const row of rows) {
      const operation = deletionOperationSchema.parse(
        JSON.parse(String(row.body_json)) as unknown,
      );
      if (operation.tombstoneKeyVerifier !== expectedVerifier) {
        throw new InvalidCanonicalSchemaError(
          "Canonical deletion identity key does not match tombstones.",
        );
      }
    }
  }

  #deletionIdentityKeyVerifier(): string {
    return deletionIdentityDigest(
      "key",
      "provenloop-deletion-tombstone-key",
      this.#deletionIdentityKey,
    );
  }

  #assertNoRestoreBarrier(): void {
    if (
      this.#path !== ":memory:" &&
      existsSync(`${this.#path}.restore.lock`)
    ) {
      throw new Error(
        "Canonical writes are blocked by an active restore.",
      );
    }
  }

  #writeDeletionOperation(operation: DeletionOperation): void {
    this.#database
        .prepare(
          `UPDATE deletion_operations
              SET status = ?,
                  body_json = ?,
                  updated_at = ?
            WHERE deletion_id = ?`,
        )
        .run(
          operation.status,
          JSON.stringify(operation),
          operation.completedAt ?? this.#now().toISOString(),
          operation.deletionId,
        );
  }

  #captureEnvelopeDeletionBlocked(
    envelope: CaptureEnvelope,
  ): boolean {
    return this.#deletionIdentitiesBlocked([
        {
          identifier: envelope.deduplicationKey,
          identityType: "deduplication" as const,
        },
        {
          identifier: envelope.event.eventId,
          identityType: "event" as const,
        },
        ...(envelope.event.sessionId === undefined
          ? []
          : [
              {
                identifier: envelope.event.sessionId,
                identityType: "session" as const,
              },
            ]),
        ...(envelope.event.parentEventId === undefined
          ? []
          : [
              {
                identifier: envelope.event.parentEventId,
                identityType: "event" as const,
              },
            ]),
    ]);
  }

  #recordRejected(
    item: CaptureQueueItem,
    deduplicationKey: string,
    errorKind: string,
    message: string,
    safeEnvelopeJson: string | undefined,
  ): boolean {
    const now = this.#now().toISOString();
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      if (this.hasActiveDeletion()) {
        throw new Error(
          "Canonical ingestion is blocked by an active deletion.",
        );
      }
      if (
        this.#captureEnvelopeDeletionBlocked(item.envelope) ||
        this.deletionIdentityBlocked(
          "deduplication",
          deduplicationKey,
        )
      ) {
        this.#database.exec("ROLLBACK;");
        return false;
      }
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
      return true;
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
      const applicableMigrations = migrations.filter(
        (migration) => migration.version <= expectedVersion,
      );
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
        ...(expectedVersion >= 2 ? ["branch_contexts"] : []),
        ...(expectedVersion >= 3 ? ["knowledge_candidates"] : []),
        ...(expectedVersion >= 4 ? ["context_use_records"] : []),
        ...(expectedVersion >= 5 ? ["session_mutes"] : []),
        ...(expectedVersion >= 6
          ? [
              "correction_keys",
              "correction_opportunities",
            ]
          : []),
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
        createExpectedCanonicalObjectSql(applicableMigrations);
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
        if (
          (table === "branch_contexts" && expectedVersion < 2) ||
          (
            table === "knowledge_candidates" &&
            expectedVersion < 3
          ) ||
          (
            table === "context_use_records" &&
            expectedVersion < 4
          ) ||
          (
            table === "session_mutes" &&
            expectedVersion < 5
          ) ||
          (
            (
              table === "correction_keys" ||
              table === "correction_opportunities"
            ) &&
            expectedVersion < 6
          )
        ) {
          continue;
        }
        CanonicalSqliteStore.#assertTableColumns(
          database,
          table,
          expectedColumns,
        );
      }
      for (const [table, expectedIndexes] of Object.entries(
        RUNTIME_SCHEMA_INDEXES,
      )) {
        if (
          (table === "branch_contexts" && expectedVersion < 2) ||
          (
            table === "knowledge_candidates" &&
            expectedVersion < 3
          ) ||
          (
            table === "context_use_records" &&
            expectedVersion < 4
          ) ||
          (
            table === "session_mutes" &&
            expectedVersion < 5
          ) ||
          (
            (
              table === "correction_keys" ||
              table === "correction_opportunities"
            ) &&
            expectedVersion < 6
          )
        ) {
          continue;
        }
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
            expected.unique ?? true
          ) === (asNumber(index.unique) === 1) &&
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
    if (version === 0 || version > latestVersion) {
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
        `${path}.deletion.key`,
        `${path}-shm`,
        `${path}-wal`,
      ].map((file) =>
        unlink(file).catch(CanonicalSqliteStore.#ignoreMissing),
      ),
    );
  }
}
