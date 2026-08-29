import {
  appendFile,
  mkdir,
  open,
} from "node:fs/promises";
import { dirname } from "node:path";

import {
  evidenceLedgerEntrySchema,
  type EvidenceLedgerEntry,
} from "@provenloop/contracts";

import { sha256 } from "./digest.js";
import {
  immutableLedgerIdentifierContainsSecret,
  ledgerEntryContainsSecret,
} from "./secret-detection.js";

export class UnsafeLedgerIdentifierError extends Error {
  public override readonly name = "UnsafeLedgerIdentifierError";

  public constructor() {
    super("Evidence Ledger contains an unsafe immutable identifier.");
  }
}

export class DuplicateLedgerEntryError extends Error {
  public override readonly name = "DuplicateLedgerEntryError";

  public constructor() {
    super("Evidence Ledger contains a duplicate ledgerEntryId.");
  }
}

export class EvidenceLedgerWriter {
  readonly #path: string;
  #appendChain: Promise<void> = Promise.resolve();
  #initialized = false;
  readonly #ledgerEntryIds = new Set<string>();

  public constructor(path: string) {
    this.#path = path;
  }

  public get path(): string {
    return this.#path;
  }

  public async initialize(): Promise<void> {
    await mkdir(dirname(this.#path), {
      recursive: true,
    });
    const handle = await open(this.#path, "ax");
    await handle.close();
    this.#initialized = true;
  }

  public async append(
    entries: readonly EvidenceLedgerEntry[],
  ): Promise<readonly EvidenceLedgerEntry[]> {
    const operation = this.#appendChain.then(() =>
      this.#appendExclusive(entries),
    );
    this.#appendChain = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async #appendExclusive(
    entries: readonly EvidenceLedgerEntry[],
  ): Promise<readonly EvidenceLedgerEntry[]> {
    if (!this.#initialized) {
      throw new Error("Evidence Ledger is not initialized.");
    }
    if (entries.length === 0) {
      return [];
    }

    const persistedEntries = entries.map((entry) => {
      const parsed = evidenceLedgerEntrySchema.parse(entry);
      if (immutableLedgerIdentifierContainsSecret(parsed)) {
        throw new UnsafeLedgerIdentifierError();
      }
      if (!ledgerEntryContainsSecret(parsed)) {
        return parsed;
      }
      return evidenceLedgerEntrySchema.parse({
        schemaVersion: parsed.schemaVersion,
        ledgerEntryId: parsed.ledgerEntryId,
        runId: parsed.runId,
        status: "secret.redacted_before_ledger",
        inputDigest: sha256(parsed),
        timestamp: parsed.timestamp,
      });
    });
    const batchIds = new Set<string>();
    for (const entry of persistedEntries) {
      if (
        batchIds.has(entry.ledgerEntryId) ||
        this.#ledgerEntryIds.has(entry.ledgerEntryId)
      ) {
        throw new DuplicateLedgerEntryError();
      }
      batchIds.add(entry.ledgerEntryId);
    }
    const body = persistedEntries
      .map((entry) => JSON.stringify(entry))
      .join("\n");
    await appendFile(this.#path, `${body}\n`, "utf8");
    for (const entry of persistedEntries) {
      this.#ledgerEntryIds.add(entry.ledgerEntryId);
    }
    return persistedEntries;
  }
}
