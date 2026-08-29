import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";

import {
  captureQueueItemSchema,
  CURRENT_SCHEMA_VERSION,
  type CaptureQueueItem,
  type CaptureQueueState,
} from "@provenloop/contracts";
import {
  createCaptureEnvelope,
  isProvenLoopInternalEnvironment,
  sanitizeDiagnostic,
  type CaptureEventInput,
  type CaptureRedactionLimits,
} from "@provenloop/domain";

const queueItemIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

export interface EnqueueCaptureOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly redactionLimits?: Partial<CaptureRedactionLimits>;
}

export interface CaptureQueueClaim {
  readonly attemptCount: number;
  readonly claimOwnerId: string;
  readonly queueItemId: string;
}

export interface WindowsCaptureQueueOptions {
  readonly acknowledgedRetentionMs?: number;
  readonly claimLeaseMs?: number;
  readonly idGenerator?: () => string;
  readonly maxAttempts?: number;
  readonly now?: () => Date;
  readonly retryBaseDelayMs?: number;
  readonly retryMaxDelayMs?: number;
}

export class CaptureQueueNotInitializedError extends Error {
  public override readonly name = "CaptureQueueNotInitializedError";

  public constructor() {
    super("The capture queue must be initialized before use.");
  }
}

export class InvalidCaptureQueueConfigurationError extends Error {
  public override readonly name = "InvalidCaptureQueueConfigurationError";

  public constructor(option: string) {
    super(`Capture queue option ${option} must be a positive integer.`);
  }
}

export class InvalidQueueItemIdError extends Error {
  public override readonly name = "InvalidQueueItemIdError";

  public constructor() {
    super("Capture queue item ID is invalid.");
  }
}

export class DuplicateQueueItemIdError extends Error {
  public override readonly name = "DuplicateQueueItemIdError";

  public constructor(queueItemId: string) {
    super(`Capture queue item ${queueItemId} already exists.`);
  }
}

export class CaptureQueueItemNotFoundError extends Error {
  public override readonly name = "CaptureQueueItemNotFoundError";

  public constructor(queueItemId: string) {
    super(`Capture queue item ${queueItemId} was not found.`);
  }
}

export class CorruptCaptureQueueItemError extends Error {
  public override readonly name = "CorruptCaptureQueueItemError";

  public constructor(queueItemId: string) {
    super(`Capture queue item ${queueItemId} is malformed.`);
  }
}

export class InvalidCaptureQueueTransitionError extends Error {
  public override readonly name = "InvalidCaptureQueueTransitionError";

  public constructor(
    queueItemId: string,
    state: CaptureQueueState,
    operation: string,
  ) {
    super(
      `Cannot ${operation} capture queue item ${queueItemId} from ${state}.`,
    );
  }
}

export class StaleCaptureQueueClaimError extends Error {
  public override readonly name = "StaleCaptureQueueClaimError";

  public constructor(queueItemId: string) {
    super(`Capture queue claim for ${queueItemId} is stale or expired.`);
  }
}

const positiveInteger = (
  value: number,
  option: string,
): number => {
  if (!Number.isInteger(value) || value <= 0) {
    throw new InvalidCaptureQueueConfigurationError(option);
  }
  return value;
};

export class WindowsCaptureQueue {
  readonly #acknowledgedRetentionMs: number;
  readonly #claimLeaseMs: number;
  readonly #idGenerator: () => string;
  #initialized = false;
  readonly #maxAttempts: number;
  readonly #now: () => Date;
  #operationChain: Promise<void> = Promise.resolve();
  readonly #retryBaseDelayMs: number;
  readonly #retryMaxDelayMs: number;
  readonly #root: string;

  public constructor(
    root: string,
    options: WindowsCaptureQueueOptions = {},
  ) {
    this.#root = root;
    this.#acknowledgedRetentionMs = positiveInteger(
      options.acknowledgedRetentionMs ?? 7 * 24 * 60 * 60 * 1_000,
      "acknowledgedRetentionMs",
    );
    this.#claimLeaseMs = positiveInteger(
      options.claimLeaseMs ?? 30_000,
      "claimLeaseMs",
    );
    this.#idGenerator = options.idGenerator ?? randomUUID;
    this.#maxAttempts = positiveInteger(
      options.maxAttempts ?? 3,
      "maxAttempts",
    );
    this.#now = options.now ?? (() => new Date());
    this.#retryBaseDelayMs = positiveInteger(
      options.retryBaseDelayMs ?? 1_000,
      "retryBaseDelayMs",
    );
    this.#retryMaxDelayMs = positiveInteger(
      options.retryMaxDelayMs ?? 60_000,
      "retryMaxDelayMs",
    );
  }

  public get root(): string {
    return this.#root;
  }

  public async initialize(): Promise<void> {
    await mkdir(this.#root, {
      recursive: true,
    });
    this.#initialized = true;
  }

  public enqueue(
    input: CaptureEventInput,
    options: EnqueueCaptureOptions = {},
  ): Promise<CaptureQueueItem> {
    return this.#runExclusive(async () => {
      this.#assertInitialized();
      const now = this.#now().toISOString();
      const queueItemId = this.#nextQueueItemId();
      if (await this.#exists(queueItemId)) {
        throw new DuplicateQueueItemIdError(queueItemId);
      }
      const internalSession =
        input.internalSession === true ||
        isProvenLoopInternalEnvironment(
          options.environment ?? process.env,
        );
      const envelope = createCaptureEnvelope(
        {
          ...input,
          ...(internalSession
            ? {
                internalSession: true,
              }
            : {}),
        },
        {
          capturedAt: now,
          ...(options.redactionLimits === undefined
            ? {}
            : {
                redactionLimits: options.redactionLimits,
              }),
        },
      );
      const item = captureQueueItemSchema.parse({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        attemptCount: 0,
        createdAt: now,
        envelope,
        queueItemId,
        state: "pending",
        updatedAt: now,
      });
      await this.#write(item);
      return item;
    });
  }

  public list(
    state?: CaptureQueueState,
  ): Promise<readonly CaptureQueueItem[]> {
    return this.#runExclusive(async () => {
      this.#assertInitialized();
      const items = await this.#readAll();
      return state === undefined
        ? items
        : items.filter((item) => item.state === state);
    });
  }

  public get(queueItemId: string): Promise<CaptureQueueItem> {
    return this.#runExclusive(async () => {
      this.#assertInitialized();
      return this.#read(queueItemId);
    });
  }

  public claimNext(
    claimOwnerId: string,
  ): Promise<CaptureQueueItem | undefined> {
    return this.#runExclusive(async () => {
      this.#assertInitialized();
      if (claimOwnerId.trim().length === 0) {
        throw new InvalidQueueItemIdError();
      }
      const now = this.#now();
      const item = (await this.#readAll()).find(
        (candidate) =>
          candidate.state === "pending" ||
          (
            candidate.state === "retry" &&
            Date.parse(candidate.nextAttemptAt) <= now.getTime()
          ),
      );
      if (item === undefined) {
        return undefined;
      }
      const timestamp = now.toISOString();
      const claimed = captureQueueItemSchema.parse({
        ...this.#baseItem(item, timestamp),
        attemptCount: item.attemptCount + 1,
        claimedAt: timestamp,
        claimExpiresAt: new Date(
          now.getTime() + this.#claimLeaseMs,
        ).toISOString(),
        claimOwnerId,
        state: "claimed",
      });
      await this.#write(claimed);
      return claimed;
    });
  }

  public acknowledge(
    claim: CaptureQueueClaim,
  ): Promise<CaptureQueueItem> {
    return this.#runExclusive(async () => {
      this.#assertInitialized();
      const item = await this.#read(claim.queueItemId);
      this.#assertActiveClaim(item, claim, "acknowledge");
      const timestamp = this.#now().toISOString();
      const acknowledged = captureQueueItemSchema.parse({
        ...this.#baseItem(item, timestamp),
        acknowledgedAt: timestamp,
        state: "acknowledged",
      });
      await this.#write(acknowledged);
      return acknowledged;
    });
  }

  public retry(
    claim: CaptureQueueClaim,
    error: unknown,
    nextAttemptAt?: string,
  ): Promise<CaptureQueueItem> {
    return this.#runExclusive(async () => {
      this.#assertInitialized();
      const item = await this.#read(claim.queueItemId);
      this.#assertActiveClaim(item, claim, "retry");
      return this.#retryClaimed(item, error, nextAttemptAt);
    });
  }

  public deadLetter(
    claim: CaptureQueueClaim,
    error: unknown,
  ): Promise<CaptureQueueItem> {
    return this.#runExclusive(async () => {
      this.#assertInitialized();
      const item = await this.#read(claim.queueItemId);
      this.#assertActiveClaim(item, claim, "dead-letter");
      const deadLetter = this.#deadLetterItem(item, error);
      await this.#write(deadLetter);
      return deadLetter;
    });
  }

  public recoverExpiredClaims(): Promise<readonly CaptureQueueItem[]> {
    return this.#runExclusive(async () => {
      this.#assertInitialized();
      const now = this.#now();
      const expired = (await this.#readAll()).filter(
        (
          item,
        ): item is Extract<
          CaptureQueueItem,
          { readonly state: "claimed" }
        > =>
          item.state === "claimed" &&
          Date.parse(item.claimExpiresAt) <= now.getTime(),
      );
      const recovered: CaptureQueueItem[] = [];
      for (const item of expired) {
        recovered.push(
          await this.#retryClaimed(
            item,
            "Claim lease expired before acknowledgement.",
          ),
        );
      }
      return recovered;
    });
  }

  public pruneAcknowledged(): Promise<readonly string[]> {
    return this.#runExclusive(async () => {
      this.#assertInitialized();
      const cutoff =
        this.#now().getTime() - this.#acknowledgedRetentionMs;
      const acknowledged = (await this.#readAll()).filter(
        (item) =>
          item.state === "acknowledged" &&
          Date.parse(item.acknowledgedAt) <= cutoff,
      );
      await Promise.all(
        acknowledged.map((item) =>
          unlink(this.#path(item.queueItemId)),
        ),
      );
      return acknowledged.map((item) => item.queueItemId);
    });
  }

  async #retryClaimed(
    item: Extract<CaptureQueueItem, { readonly state: "claimed" }>,
    error: unknown,
    nextAttemptAt?: string,
  ): Promise<CaptureQueueItem> {
    if (item.attemptCount >= this.#maxAttempts) {
      const deadLetter = this.#deadLetterItem(item, error);
      await this.#write(deadLetter);
      return deadLetter;
    }
    const now = this.#now();
    const timestamp = now.toISOString();
    const retryItem = captureQueueItemSchema.parse({
      ...this.#baseItem(item, timestamp),
      lastError: sanitizeDiagnostic(error),
      nextAttemptAt:
        nextAttemptAt ??
        new Date(
          now.getTime() + this.#retryDelay(item.attemptCount),
        ).toISOString(),
      state: "retry",
    });
    await this.#write(retryItem);
    return retryItem;
  }

  #deadLetterItem(
    item: CaptureQueueItem,
    error: unknown,
  ): CaptureQueueItem {
    return captureQueueItemSchema.parse({
      ...this.#baseItem(item, this.#now().toISOString()),
      lastError: sanitizeDiagnostic(error),
      state: "dead-letter",
    });
  }

  #retryDelay(attemptCount: number): number {
    return Math.min(
      this.#retryBaseDelayMs * 2 ** Math.max(0, attemptCount - 1),
      this.#retryMaxDelayMs,
    );
  }

  #assertActiveClaim(
    item: CaptureQueueItem,
    claim: CaptureQueueClaim,
    operation: string,
  ): asserts item is Extract<
    CaptureQueueItem,
    { readonly state: "claimed" }
  > {
    if (item.state !== "claimed") {
      throw new InvalidCaptureQueueTransitionError(
        claim.queueItemId,
        item.state,
        operation,
      );
    }
    if (
      item.claimOwnerId !== claim.claimOwnerId ||
      item.attemptCount !== claim.attemptCount ||
      Date.parse(item.claimExpiresAt) <= this.#now().getTime()
    ) {
      throw new StaleCaptureQueueClaimError(claim.queueItemId);
    }
  }

  #baseItem(
    item: CaptureQueueItem,
    updatedAt: string,
  ): {
    readonly attemptCount: number;
    readonly createdAt: string;
    readonly envelope: CaptureQueueItem["envelope"];
    readonly queueItemId: string;
    readonly schemaVersion: 1;
    readonly updatedAt: string;
  } {
    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      attemptCount: item.attemptCount,
      createdAt: item.createdAt,
      envelope: item.envelope,
      queueItemId: item.queueItemId,
      updatedAt,
    };
  }

  async #readAll(): Promise<readonly CaptureQueueItem[]> {
    const entries = await readdir(this.#root, {
      withFileTypes: true,
    });
    const items = await Promise.all(
      entries
        .filter(
          (entry) =>
            entry.isFile() && entry.name.endsWith(".json"),
        )
        .map((entry) =>
          this.#read(entry.name.slice(0, -".json".length)),
        ),
    );
    return items.sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.queueItemId.localeCompare(right.queueItemId),
    );
  }

  async #read(queueItemId: string): Promise<CaptureQueueItem> {
    this.#validateQueueItemId(queueItemId);
    let serialized: string;
    try {
      serialized = await readFile(this.#path(queueItemId), "utf8");
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        throw new CaptureQueueItemNotFoundError(queueItemId);
      }
      throw error;
    }
    let input: unknown;
    try {
      input = JSON.parse(serialized) as unknown;
    } catch {
      throw new CorruptCaptureQueueItemError(queueItemId);
    }
    const parsed = captureQueueItemSchema.safeParse(input);
    if (!parsed.success || parsed.data.queueItemId !== queueItemId) {
      throw new CorruptCaptureQueueItemError(queueItemId);
    }
    return parsed.data;
  }

  async #write(item: CaptureQueueItem): Promise<void> {
    const parsed = captureQueueItemSchema.parse(item);
    const temporaryPath = join(
      this.#root,
      `.queue-${parsed.queueItemId}-${randomUUID()}.tmp`,
    );
    const handle = await open(temporaryPath, "wx");
    try {
      await handle.writeFile(`${JSON.stringify(parsed)}\n`, "utf8");
      await handle.sync();
    } catch (error) {
      await handle.close();
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
    await handle.close();
    try {
      await rename(temporaryPath, this.#path(parsed.queueItemId));
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  async #exists(queueItemId: string): Promise<boolean> {
    try {
      await access(this.#path(queueItemId));
      return true;
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return false;
      }
      throw error;
    }
  }

  #nextQueueItemId(): string {
    const queueItemId = this.#idGenerator();
    this.#validateQueueItemId(queueItemId);
    return queueItemId;
  }

  #path(queueItemId: string): string {
    this.#validateQueueItemId(queueItemId);
    return join(this.#root, `${queueItemId}.json`);
  }

  #validateQueueItemId(queueItemId: string): void {
    if (!queueItemIdPattern.test(queueItemId)) {
      throw new InvalidQueueItemIdError();
    }
  }

  #assertInitialized(): void {
    if (!this.#initialized) {
      throw new CaptureQueueNotInitializedError();
    }
  }

  #runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operationChain.then(operation);
    this.#operationChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
