import { existsSync, readFileSync } from "node:fs";
import type { SQLInputValue } from "node:sqlite";
import {
  captureEnvelopeSchema, contextUseRecordSchema, deletionOperationSchema, feedbackEventSchema,
  knowledgeCandidateSchema, learningJobSchema, learningRecoveryReceiptSchema,
  ruleProposalSchema, workEpisodeSchema,
} from "@provenloop/contracts";
import { deletionIdentityDigest, sha256 } from "@provenloop/domain";
import { DEFAULT_SQLITE_MIGRATIONS } from "./canonical-store.js";
import { DatabaseSync } from "./node-sqlite.js";

export const INSPECTION_PAGE_SIZE = 40;
export type InspectionCollection = "knowledge" | "events" | "jobs" | "usage" | "episodes";
export interface InspectionFilter {
  readonly page?: number;
  readonly query?: string;
  readonly state?: string;
  readonly scope?: string;
  readonly session?: string;
}

const collections = {
  knowledge: { table: "knowledge_candidates", id: "knowledge_id", time: "updated_at",
    search: "json_extract(body_json, '$.content')", schema: knowledgeCandidateSchema },
  events: { table: "raw_events", id: "deduplication_key", time: "event_timestamp",
    search: "event_type || ' ' || coalesce(session_id, '') || ' ' || coalesce(worktree, '')", schema: captureEnvelopeSchema },
  jobs: { table: "learning_jobs", id: "job_id", time: "updated_at",
    search: "job_id || ' ' || state || ' ' || coalesce(json_extract(body_json, '$.pauseReason'), '')", schema: learningJobSchema },
  usage: { table: "context_use_records", id: "request_id", time: "created_at",
    search: "session_id || ' ' || coalesce(json_extract(body_json, '$.repoId'), '')", schema: contextUseRecordSchema },
  episodes: { table: "work_episodes", id: "episode_id", time: "updated_at",
    search: "json_extract(body_json, '$.goal')", schema: workEpisodeSchema },
} as const;

const optionalText = (path: string): string | undefined => {
  try { return readFileSync(path, "utf8").trim(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

/** One short snapshot per page. Never initializes, migrates, or opens the FTS writer. */
export const readInspection = <T>(path: string, read: (reader: InspectionReader) => T): T => {
  if (!existsSync(path)) throw new Error("No ProvenLoop database found. Check --data-root or install ProvenLoop first.");
  const generation = optionalText(`${path}.restore.generation`);
  const key = optionalText(`${path}.deletion.key`);
  if (!key || !/^[a-f0-9]{64}$/u.test(key)) throw new Error("The storage identity key is missing or malformed. Run provenloop doctor before browsing.");
  const guard = (): void => {
    if (existsSync(`${path}.restore.lock`) || generation !== optionalText(`${path}.restore.generation`) ||
      key !== optionalText(`${path}.deletion.key`)) {
      throw new Error("Storage is being restored or replaced. Refresh after maintenance finishes.");
    }
  };
  guard();
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    database.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 1000; PRAGMA trusted_schema = OFF;");
    const version = Number(database.prepare("PRAGMA user_version").get()?.user_version);
    const supported = DEFAULT_SQLITE_MIGRATIONS.at(-1)?.version;
    if (version !== supported) throw new Error(
      `Database schema ${version} cannot be viewed by this CLI (expected ${supported}). Use a matching CLI or upgrade through provenloop upgrade.`,
    );
    const checkDeletion = (): void => {
      if (database.prepare("SELECT 1 FROM deletion_operations WHERE status IN ('running', 'completing', 'failed') LIMIT 1").get()) {
        throw new Error("Evidence is unavailable while deletion is pending. Finish or recover the deletion, then refresh.");
      }
    };
    database.exec("BEGIN;");
    checkDeletion();
    const verifier = deletionIdentityDigest("key", "provenloop-deletion-tombstone-key", key);
    for (const row of database.prepare("SELECT body_json FROM deletion_operations").iterate()) {
      const operation = deletionOperationSchema.parse(JSON.parse(String(row.body_json)));
      if (operation.tombstoneKeyVerifier !== verifier) throw new Error("Storage identity does not match deletion history. Run provenloop doctor.");
    }
    const result = read(new InspectionReader(database));
    database.exec("COMMIT;");
    guard();
    checkDeletion();
    return result;
  } finally { database.close(); }
};

export class InspectionReader {
  public constructor(private readonly database: DatabaseSync) {}

  public summary() {
    const counts = Object.fromEntries(Object.entries(collections).map(([name, { table }]) =>
      [name, Number(this.database.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n)]));
    const states = this.database.prepare("SELECT json_extract(body_json, '$.state') AS state, count(*) AS count FROM knowledge_candidates GROUP BY state").all();
    const latest = this.database.prepare("SELECT max(event_timestamp) AS timestamp FROM raw_events").get()?.timestamp;
    const usage = this.database.prepare(`SELECT count(*) AS requests,
      sum(CASE WHEN json_array_length(body_json, '$.returnedKnowledgeIds') > 0 THEN 1 ELSE 0 END) AS provided,
      sum(CASE WHEN json_array_length(body_json, '$.appliedKnowledgeIds') > 0 THEN 1 ELSE 0 END) AS adopted
      FROM context_use_records`).get();
    return { counts, states, latest: latest ?? null, usage };
  }

  public list(collection: InspectionCollection, filter: InspectionFilter = {}) {
    const definition = collections[collection];
    const page = filter.page ?? 1;
    if (!Number.isSafeInteger(page) || page < 1 || page > 100_000) throw new Error("Invalid page number.");
    const predicates: string[] = [];
    const values: SQLInputValue[] = [];
    if (filter.query) {
      predicates.push(`instr(lower(${definition.search}), lower(?)) > 0`);
      values.push(filter.query.slice(0, 256));
    }
    if (filter.state && (collection === "knowledge" || collection === "jobs")) {
      predicates.push("json_extract(body_json, '$.state') = ?"); values.push(filter.state);
    }
    if (filter.scope && collection === "knowledge") {
      predicates.push("json_extract(body_json, '$.scope') = ?"); values.push(filter.scope);
    }
    if (filter.session && (collection === "events" || collection === "usage")) {
      predicates.push("session_id = ?"); values.push(filter.session);
    }
    const where = predicates.length ? `WHERE ${predicates.join(" AND ")}` : "";
    const total = Number(this.database.prepare(`SELECT count(*) AS n FROM ${definition.table} ${where}`).get(...values)?.n);
    // Timeline pages fetch metadata only; captured content is fetched on deliberate detail navigation.
    const selection = collection === "events"
      ? "deduplication_key, event_id, event_type, event_timestamp, session_id, repo_id, worktree, trust" : "body_json";
    const rows = this.database.prepare(`SELECT ${selection} FROM ${definition.table} ${where}
      ORDER BY ${definition.time} DESC, ${definition.id} DESC LIMIT ? OFFSET ?`)
      .all(...values, INSPECTION_PAGE_SIZE, (page - 1) * INSPECTION_PAGE_SIZE);
    return { total, page, pageSize: INSPECTION_PAGE_SIZE, rows: rows.map((row) => collection === "events"
      ? row : definition.schema.parse(JSON.parse(String(row.body_json)))) };
  }

  public knowledge(id: string) {
    const row = this.database.prepare("SELECT body_json FROM knowledge_candidates WHERE knowledge_id = ?").get(id);
    if (!row) return undefined;
    const candidate = knowledgeCandidateSchema.parse(JSON.parse(String(row.body_json)));
    const proposals = this.proposals("knowledge_id", id);
    const feedback = this.database.prepare("SELECT body_json FROM feedback_events WHERE json_extract(body_json, '$.targetId') = ? ORDER BY created_at DESC LIMIT 101").all(id)
      .map((item) => feedbackEventSchema.parse(JSON.parse(String(item.body_json))));
    const usage = this.database.prepare(`SELECT body_json FROM context_use_records WHERE
      EXISTS (SELECT 1 FROM json_each(body_json, '$.returnedKnowledgeIds') WHERE value IN (?, ?)) OR
      EXISTS (SELECT 1 FROM json_each(body_json, '$.appliedKnowledgeIds') WHERE value IN (?, ?))
      ORDER BY created_at DESC LIMIT 101`).all(id, `knowledge:${id}`, id, `knowledge:${id}`)
      .map((item) => contextUseRecordSchema.parse(JSON.parse(String(item.body_json))));
    return { candidate, proposals, feedback, usage };
  }

  public proposals(column: "knowledge_id" | "job_id", id: string) {
    return this.database.prepare(`SELECT body_json, receipt_json FROM learning_proposals WHERE ${column} = ? ORDER BY json_extract(body_json, '$.createdAt') DESC, proposal_id DESC LIMIT 101`).all(id)
      .map((row) => ({
        proposal: ruleProposalSchema.parse(JSON.parse(String(row.body_json))),
        receipt: row.receipt_json === null ? null : learningRecoveryReceiptSchema.parse(JSON.parse(String(row.receipt_json))),
      }));
  }

  public event(id: string) {
    const rows = this.database.prepare("SELECT safe_envelope_json, parse_status FROM raw_events WHERE deduplication_key = ? OR event_id = ? LIMIT 2").all(id, id);
    if (rows.length > 1) throw new Error("This event ID is ambiguous. Open it from the activity list instead.");
    const row = rows[0];
    if (!row) return undefined;
    const original = captureEnvelopeSchema.parse(JSON.parse(String(row.safe_envelope_json)));
    const enrichment = this.database.prepare("SELECT original_digest, safe_envelope_json FROM raw_event_enrichments WHERE deduplication_key = ? ORDER BY rowid DESC LIMIT 1").get(original.deduplicationKey);
    if (enrichment && enrichment.original_digest !== sha256(original)) throw new Error("Event enrichment does not match its source.");
    const envelope = enrichment ? captureEnvelopeSchema.parse(JSON.parse(String(enrichment.safe_envelope_json))) : original;
    return { envelope, parseStatus: String(row.parse_status), enriched: Boolean(enrichment) };
  }

  public job(id: string) {
    const row = this.database.prepare("SELECT body_json FROM learning_jobs WHERE job_id = ?").get(id);
    return row ? { job: learningJobSchema.parse(JSON.parse(String(row.body_json))), proposals: this.proposals("job_id", id) } : undefined;
  }

  public episode(id: string) {
    const row = this.database.prepare("SELECT body_json FROM work_episodes WHERE episode_id = ?").get(id);
    return row ? workEpisodeSchema.parse(JSON.parse(String(row.body_json))) : undefined;
  }
}
