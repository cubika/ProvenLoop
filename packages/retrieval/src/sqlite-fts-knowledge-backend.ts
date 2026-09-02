import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";

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

const READ_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");

try {
  const database = new DatabaseSync(workerData.path, {
    readOnly: true,
  });
  parentPort.on("message", (request) => {
    if (request.operation === "close") {
      database.close();
      process.exit(0);
      return;
    }
    try {
      database.exec(
        "PRAGMA busy_timeout = " + request.timeoutMs + ";",
      );
      let result;
      if (request.operation === "health") {
        const quickCheck = database.prepare("PRAGMA quick_check;").get();
        const count = database.prepare(
          "SELECT COUNT(*) AS count FROM knowledge_records",
        ).get();
        const fts5 = database.prepare(
          "SELECT COUNT(*) AS count " +
          "FROM sqlite_master " +
          "WHERE type = 'table' AND name = 'knowledge_fts'",
        ).get();
        result = {
          fts5Available: Number(fts5.count) === 1,
          quickCheck: String(Object.values(quickCheck)[0]),
          recordCount: Number(count.count),
        };
      } else if (request.operation === "search") {
        const quickCheck = database.prepare("PRAGMA quick_check;").get();
        const fts5 = database.prepare(
          "SELECT COUNT(*) AS count " +
          "FROM sqlite_master " +
          "WHERE type = 'table' AND name = 'knowledge_fts'",
        ).get();
        if (
          String(Object.values(quickCheck)[0]) !== "ok" ||
          Number(fts5.count) !== 1
        ) {
          throw new Error("Knowledge backend is unhealthy.");
        }
        const rows = database.prepare(
          "SELECT records.projection_json, " +
          "bm25(knowledge_fts, 0.0, 4.0, 2.0, 1.0, 0.25) AS rank " +
          "FROM knowledge_fts " +
          "JOIN knowledge_records AS records " +
          "ON records.knowledge_id = knowledge_fts.knowledge_id " +
          "WHERE knowledge_fts MATCH ? " +
          "ORDER BY rank, knowledge_fts.knowledge_id " +
          "LIMIT ? OFFSET ?",
        ).all(
          request.match,
          request.limit,
          request.offset,
        );
        result = rows.map((row) => ({
          projectionJson: String(row.projection_json),
          rank: Number(row.rank),
        }));
      } else {
        throw new Error("Unknown Knowledge backend read operation.");
      }
      parentPort.postMessage({
        ok: true,
        requestId: request.requestId,
        result,
      });
    } catch (error) {
      parentPort.postMessage({
        error: error instanceof Error ? error.message : String(error),
        ok: false,
        requestId: request.requestId,
      });
    }
  });
} catch (error) {
  parentPort.postMessage({
    error: error instanceof Error ? error.message : String(error),
    fatal: true,
    ok: false,
  });
}
`;

interface ReadWorkerResponse<T> {
  readonly error?: string;
  readonly fatal?: boolean;
  readonly ok: boolean;
  readonly requestId?: number;
  readonly result?: T;
}

interface PendingReadRequest {
  readonly reject: (error: Error) => void;
  readonly resolve: (result: unknown) => void;
  readonly timer: NodeJS.Timeout;
}

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

export interface SqliteFtsKnowledgeBackendOptions {
  readonly busyTimeoutMs?: number;
}

export class SqliteFtsKnowledgeBackend
implements KnowledgeBackend {
  readonly #database: DatabaseSync;
  readonly #path: string;
  readonly #pendingReadRequests =
    new Map<number, PendingReadRequest>();
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #nextReadRequestId = 0;
  #readWorker: Worker | undefined;
  #readWorkerError: Error | undefined;

  public constructor(
    path: string,
    options: SqliteFtsKnowledgeBackendOptions = {},
  ) {
    const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
    if (
      !Number.isInteger(busyTimeoutMs) ||
      busyTimeoutMs <= 0
    ) {
      throw new RangeError(
        "Knowledge backend busy timeout must be positive.",
      );
    }
    if (path !== ":memory:") {
      mkdirSync(dirname(path), {
        recursive: true,
      });
    }
    this.#path = path;
    this.#database = new DatabaseSync(path);
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = ${busyTimeoutMs};

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
    this.#startReadWorker();
  }

  public close(): void {
    if (this.#closePromise !== undefined) {
      return;
    }
    this.#closed = true;
    const worker = this.#readWorker;
    this.#readWorker = undefined;
    this.#failPendingReads(
      new Error("Knowledge backend is closed."),
    );
    this.#database.close();
    this.#closePromise =
      worker === undefined
        ? Promise.resolve()
        : worker.terminate().then(() => undefined);
  }

  public closeAsync(): Promise<void> {
    if (this.#closePromise !== undefined) {
      return this.#closePromise;
    }
    this.#closed = true;
    const worker = this.#readWorker;
    this.#readWorker = undefined;
    this.#failPendingReads(
      new Error("Knowledge backend is closed."),
    );
    this.#closePromise = (async () => {
      if (worker !== undefined) {
        await worker.terminate();
      }
      this.#database.close();
    })();
    return this.#closePromise;
  }

  #startReadWorker(): void {
    if (
      this.#closed ||
      this.#path === ":memory:" ||
      this.#readWorker !== undefined
    ) {
      return;
    }
    this.#readWorkerError = undefined;
    const worker = new Worker(READ_WORKER_SOURCE, {
      eval: true,
      workerData: {
        path: this.#path,
      },
    });
    this.#readWorker = worker;
    worker.on(
      "message",
      (message: ReadWorkerResponse<unknown>) => {
        if (this.#readWorker !== worker) {
          return;
        }
        if (message.fatal === true) {
          this.#failPendingReads(
            new Error(
              message.error ??
              "Knowledge backend read worker failed.",
            ),
          );
          return;
        }
        if (message.requestId === undefined) {
          return;
        }
        const pending = this.#pendingReadRequests.get(
          message.requestId,
        );
        if (pending === undefined) {
          return;
        }
        this.#pendingReadRequests.delete(message.requestId);
        clearTimeout(pending.timer);
        if (!message.ok || message.result === undefined) {
          pending.reject(
            new Error(
              message.error ??
              "Knowledge backend read failed.",
            ),
          );
          return;
        }
        pending.resolve(message.result);
      },
    );
    worker.on("error", (error) => {
      if (this.#readWorker !== worker) {
        return;
      }
      this.#failPendingReads(error);
    });
    worker.on("exit", (code) => {
      if (
        this.#readWorker === worker &&
        code !== 0 &&
        this.#readWorkerError === undefined
      ) {
        this.#failPendingReads(
          new Error(
            `Knowledge backend read worker exited with code ${code}.`,
          ),
        );
      }
    });
  }

  async #stopReadWorker(): Promise<void> {
    const worker = this.#readWorker;
    if (worker === undefined) {
      return;
    }
    if (this.#pendingReadRequests.size > 0) {
      throw new Error(
        "Knowledge backend write attempted during an active read.",
      );
    }
    this.#readWorker = undefined;
    await worker.terminate();
    this.#readWorkerError = undefined;
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

  public async healthWithTimeout(
    timeoutMs: number,
  ): Promise<KnowledgeBackendHealth> {
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError(
        "Knowledge backend timeout must be positive.",
      );
    }
    if (this.#path === ":memory:") {
      return this.health();
    }
    const result = await this.#runReadWorker<{
      readonly fts5Available: boolean;
      readonly quickCheck: string;
      readonly recordCount: number;
    }>({
      operation: "health",
      path: this.#path,
    }, timeoutMs);
    return {
      ...result,
      status:
        result.fts5Available && result.quickCheck === "ok"
          ? "healthy"
          : "unhealthy",
    };
  }

  public async index(
    records: readonly KnowledgeProjection[],
  ): Promise<void> {
    const parsed = records.map(validateProjection);
    await this.#stopReadWorker();
    try {
      this.#database.exec("BEGIN IMMEDIATE;");
      try {
        this.#upsertRecords(parsed);
        this.#rebuildFts();
        this.#database.exec("COMMIT;");
      } catch (error) {
        this.#database.exec("ROLLBACK;");
        throw error;
      }
    } finally {
      this.#startReadWorker();
    }
  }

  public async rebuild(
    snapshot: KnowledgeProjectionSnapshot,
  ): Promise<void> {
    const parsed = snapshot.records.map(validateProjection);
    await this.#stopReadWorker();
    try {
      this.#database.exec("BEGIN IMMEDIATE;");
      try {
        this.#database.exec(`
          DELETE FROM knowledge_records;
        `);
        this.#upsertRecords(parsed);
        this.#rebuildFts();
        this.#database.exec("COMMIT;");
      } catch (error) {
        this.#database.exec("ROLLBACK;");
        throw error;
      }
    } finally {
      this.#startReadWorker();
    }
  }

  public async remove(ids: readonly string[]): Promise<void> {
    const selected = normalizedIds(ids);
    await this.#stopReadWorker();
    try {
      this.#database.exec("BEGIN IMMEDIATE;");
      try {
        const removeRecord = this.#database.prepare(
          "DELETE FROM knowledge_records WHERE knowledge_id = ?",
        );
        for (const id of selected) {
          removeRecord.run(id);
        }
        this.#rebuildFts();
        this.#database.exec("COMMIT;");
      } catch (error) {
        this.#database.exec("ROLLBACK;");
        throw error;
      }
    } finally {
      this.#startReadWorker();
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

  public async searchWithTimeout(
    query: KnowledgeQuery,
    timeoutMs: number,
  ): Promise<readonly KnowledgeRecord[]> {
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError(
        "Knowledge backend timeout must be positive.",
      );
    }
    if (!Number.isInteger(query.limit) || query.limit <= 0) {
      throw new RangeError(
        "Knowledge search limit must be positive.",
      );
    }
    const match = ftsQuery(query.text);
    if (match === undefined) {
      return [];
    }
    const offset = query.offset ?? 0;
    if (!Number.isInteger(offset) || offset < 0) {
      throw new RangeError(
        "Knowledge search offset must be non-negative.",
      );
    }
    if (this.#path === ":memory:") {
      return this.search(query);
    }
    const rows = await this.#runReadWorker<readonly {
      readonly projectionJson: string;
      readonly rank: number;
    }[]>({
      limit: query.limit,
      match,
      offset,
      operation: "search",
      path: this.#path,
    }, timeoutMs);
    return rows.map((row) => ({
      ...validateProjection(
        JSON.parse(row.projectionJson) as KnowledgeProjection,
      ),
      score: -row.rank,
    }));
  }

  #failPendingReads(error: Error): void {
    this.#readWorkerError = error;
    for (const pending of this.#pendingReadRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pendingReadRequests.clear();
  }

  #runReadWorker<T>(
    input: Readonly<Record<string, unknown>>,
    timeoutMs: number,
  ): Promise<T> {
    if (this.#readWorker === undefined) {
      return Promise.reject(
        new Error(
          "Knowledge backend read worker is unavailable.",
        ),
      );
    }
    if (this.#readWorkerError !== undefined) {
      return Promise.reject(this.#readWorkerError);
    }
    const requestId = this.#nextReadRequestId += 1;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingReadRequests.delete(requestId);
        reject(new Error("Knowledge backend read timed out."));
      }, timeoutMs);
      this.#pendingReadRequests.set(requestId, {
        reject,
        resolve: (result) => resolve(result as T),
        timer,
      });
      this.#readWorker?.postMessage({
        ...input,
        requestId,
        timeoutMs,
      });
    });
  }

  #upsertRecords(records: readonly KnowledgeProjection[]): void {
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
    for (const record of records) {
      upsert.run(
        record.knowledgeId,
        JSON.stringify(record),
        record.sourceDigest,
      );
    }
  }

  #rebuildFts(): void {
    const insert = this.#database.prepare(
      `INSERT INTO knowledge_fts (
         knowledge_id,
         topic_key,
         content,
         applies_when,
         non_applicability
       ) VALUES (?, ?, ?, ?, ?)`,
    );
    const records = (
      this.#database
        .prepare(
          `SELECT projection_json
             FROM knowledge_records
            ORDER BY knowledge_id`,
        )
        .all() as readonly Readonly<Record<string, unknown>>[]
    ).map((row) =>
      validateProjection(
        JSON.parse(
          String(row.projection_json),
        ) as KnowledgeProjection,
      ),
    );
    this.#database.exec("DELETE FROM knowledge_fts;");
    for (const record of records) {
      insert.run(
        record.knowledgeId,
        record.topicKey,
        record.content,
        record.appliesWhen.join("\n"),
        record.nonApplicability.join("\n"),
      );
    }
  }
}
