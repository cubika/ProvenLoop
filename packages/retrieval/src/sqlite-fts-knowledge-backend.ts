import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  KnowledgeBackend,
  KnowledgeBackendHealth,
  KnowledgeProjection,
  KnowledgeProjectionSnapshot,
  KnowledgeQuery,
  KnowledgeRecord,
} from "./types.js";

const normalizedIds = (ids: readonly string[]): string[] =>
  [...new Set(
    ids
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  )].sort();

const validateProjection = (
  record: KnowledgeProjection,
): KnowledgeProjection => {
  if (
    record.projectionVersion !== 1 ||
    record.knowledgeId.trim().length === 0 ||
    record.topicKey.trim().length === 0 ||
    record.content.trim().length === 0 ||
    !/^[a-f0-9]{64}$/u.test(record.sourceDigest)
  ) {
    throw new Error("Knowledge projection is invalid.");
  }
  return {
    appliesWhen: [...record.appliesWhen],
    content: record.content.trim(),
    knowledgeId: record.knowledgeId.trim(),
    nonApplicability: [...record.nonApplicability],
    projectionVersion: 1,
    sourceDigest: record.sourceDigest,
    topicKey: record.topicKey.trim(),
  };
};

const ftsQuery = (text: string): string | undefined => {
  const tokens = text
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .match(/[\p{L}\p{N}_-]+/gu);
  if (tokens === null || tokens.length === 0) {
    return undefined;
  }
  return [...new Set(tokens)]
    .map((token) => `"${token.replaceAll("\"", "\"\"")}"`)
    .join(" AND ");
};

export class SqliteFtsKnowledgeBackend
implements KnowledgeBackend {
  readonly #database: DatabaseSync;

  public constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), {
        recursive: true,
      });
    }
    this.#database = new DatabaseSync(path);
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS knowledge_records (
        knowledge_id TEXT PRIMARY KEY,
        projection_json TEXT NOT NULL,
        source_digest TEXT NOT NULL
      ) STRICT;

      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
        knowledge_id UNINDEXED,
        topic_key,
        content,
        applies_when,
        non_applicability UNINDEXED,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `);
  }

  public close(): void {
    this.#database.close();
  }

  public get(id: string): Promise<KnowledgeRecord | undefined> {
    const row = this.#database
      .prepare(
        `SELECT projection_json
           FROM knowledge_records
          WHERE knowledge_id = ?`,
      )
      .get(id.trim()) as
      | Readonly<Record<string, unknown>>
      | undefined;
    if (row === undefined) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve({
      ...validateProjection(
        JSON.parse(String(row.projection_json)) as KnowledgeProjection,
      ),
      score: 0,
    });
  }

  public health(): Promise<KnowledgeBackendHealth> {
    try {
      const quickCheck = this.#database
        .prepare("PRAGMA quick_check;")
        .get() as Readonly<Record<string, unknown>>;
      const count = this.#database
        .prepare(
          "SELECT COUNT(*) AS count FROM knowledge_records",
        )
        .get() as Readonly<Record<string, unknown>>;
      const fts5 = this.#database
        .prepare(
          `SELECT COUNT(*) AS count
             FROM sqlite_master
            WHERE type = 'table'
              AND name = 'knowledge_fts'`,
        )
        .get() as Readonly<Record<string, unknown>>;
      const result = {
        fts5Available: Number(fts5.count) === 1,
        quickCheck: String(Object.values(quickCheck)[0]),
        recordCount: Number(count.count),
      };
      return Promise.resolve({
        ...result,
        status:
          result.fts5Available && result.quickCheck === "ok"
            ? "healthy"
            : "unhealthy",
      });
    } catch {
      return Promise.resolve({
        fts5Available: false,
        quickCheck: "failed",
        recordCount: 0,
        status: "unhealthy",
      });
    }
  }

  public index(
    records: readonly KnowledgeProjection[],
  ): Promise<void> {
    const parsed = records.map(validateProjection);
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      this.#indexParsed(parsed);
      this.#database.exec("COMMIT;");
      return Promise.resolve();
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      return Promise.reject(error);
    }
  }

  public async rebuild(
    snapshot: KnowledgeProjectionSnapshot,
  ): Promise<void> {
    const parsed = snapshot.records.map(validateProjection);
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      this.#database.exec(`
        DELETE FROM knowledge_fts;
        DELETE FROM knowledge_records;
      `);
      this.#indexParsed(parsed);
      this.#database.exec("COMMIT;");
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  public remove(ids: readonly string[]): Promise<void> {
    const selected = normalizedIds(ids);
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const removeFts = this.#database.prepare(
        "DELETE FROM knowledge_fts WHERE knowledge_id = ?",
      );
      const removeRecord = this.#database.prepare(
        "DELETE FROM knowledge_records WHERE knowledge_id = ?",
      );
      for (const id of selected) {
        removeFts.run(id);
        removeRecord.run(id);
      }
      this.#database.exec("COMMIT;");
      return Promise.resolve();
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      return Promise.reject(error);
    }
  }

  public search(
    query: KnowledgeQuery,
  ): Promise<readonly KnowledgeRecord[]> {
    if (!Number.isInteger(query.limit) || query.limit <= 0) {
      return Promise.reject(
        new RangeError("Knowledge search limit must be positive."),
      );
    }
    const match = ftsQuery(query.text);
    if (match === undefined) {
      return Promise.resolve([]);
    }
    const offset = query.offset ?? 0;
    if (!Number.isInteger(offset) || offset < 0) {
      return Promise.reject(
        new RangeError("Knowledge search offset must be non-negative."),
      );
    }
    const rows = this.#database
      .prepare(
        `SELECT records.projection_json,
                bm25(knowledge_fts, 0.0, 4.0, 2.0, 1.0, 0.25)
                  AS rank
           FROM knowledge_fts
           JOIN knowledge_records AS records
             ON records.knowledge_id = knowledge_fts.knowledge_id
          WHERE knowledge_fts MATCH ?
          ORDER BY rank, knowledge_fts.knowledge_id
          LIMIT ?
         OFFSET ?`,
      )
      .all(match, query.limit, offset) as readonly Readonly<
      Record<string, unknown>
    >[];
    return Promise.resolve(
      rows.map((row) => ({
        ...validateProjection(
          JSON.parse(String(row.projection_json)) as KnowledgeProjection,
        ),
        score: -Number(row.rank),
      })),
    );
  }

  #indexParsed(records: readonly KnowledgeProjection[]): void {
    const removeFts = this.#database.prepare(
      "DELETE FROM knowledge_fts WHERE knowledge_id = ?",
    );
    const upsert = this.#database.prepare(
      `INSERT INTO knowledge_records (
         knowledge_id,
         projection_json,
         source_digest
       ) VALUES (?, ?, ?)
       ON CONFLICT(knowledge_id) DO UPDATE SET
         projection_json = excluded.projection_json,
         source_digest = excluded.source_digest`,
    );
    const insertFts = this.#database.prepare(
      `INSERT INTO knowledge_fts (
         knowledge_id,
         topic_key,
         content,
         applies_when,
         non_applicability
       ) VALUES (?, ?, ?, ?, ?)`,
    );
    for (const record of records) {
      removeFts.run(record.knowledgeId);
      upsert.run(
        record.knowledgeId,
        JSON.stringify(record),
        record.sourceDigest,
      );
      insertFts.run(
        record.knowledgeId,
        record.topicKey,
        record.content,
        record.appliesWhen.join("\n"),
        record.nonApplicability.join("\n"),
      );
    }
  }
}
