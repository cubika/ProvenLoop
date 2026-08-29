import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { captureQueueItemSchema } from "@provenloop/contracts";
import { InternalCaptureEventError } from "@provenloop/domain";
import {
  CorruptCaptureQueueItemError,
  InvalidCaptureQueueTransitionError,
  StaleCaptureQueueClaimError,
  WindowsCaptureQueue,
} from "@provenloop/platform-windows";

const temporaryDirectories: string[] = [];

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(
    join(tmpdir(), "provenloop-capture-queue-test-"),
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

const createInput = () => ({
  adapter: "copilot-cli",
  adapterVersion: "1.0.82-0",
  eventType: "tool.completed",
  operationId: "call-1",
  sessionId: "session-1",
  sourceEventId: "source-event-1",
  timestamp: "2026-08-29T00:00:00.000Z",
  toolName: "powershell",
  trust: "tool" as const,
});

describe("Windows durable capture queue", () => {
  it("atomically enqueues one queue item per source identity", async () => {
    const root = await createTemporaryDirectory();
    const firstQueue = new WindowsCaptureQueue(root, {
      idGenerator: () => "queue-item-first",
    });
    const secondQueue = new WindowsCaptureQueue(root, {
      idGenerator: () => "queue-item-second",
    });
    await Promise.all([
      firstQueue.initialize(),
      secondQueue.initialize(),
    ]);

    const results = await Promise.all([
      firstQueue.enqueueIfSourceAbsent(createInput(), {
        environment: {},
      }),
      secondQueue.enqueueIfSourceAbsent(createInput(), {
        environment: {},
      }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([
      "duplicate",
      "enqueued",
    ]);
    expect(await firstQueue.list()).toHaveLength(1);
  });

  it("redacts before an atomic pending-item write", async () => {
    const root = await createTemporaryDirectory();
    const knownSecret = "ghp_1234567890abcdefghijklmnopqrst";
    const entropySecret = "9wM3QfT7xL2nV8pR4sK6dH1cB5yJ0uZa";
    const queue = new WindowsCaptureQueue(root, {
      idGenerator: () => "queue-item-1",
      now: () => new Date("2026-08-29T00:00:01.000Z"),
    });
    await queue.initialize();

    const item = await queue.enqueue({
      ...createInput(),
      content: {
        message: knownSecret,
        toolArguments: {
          token: entropySecret,
        },
      },
    });
    const files = await readdir(root);
    const persisted = await readFile(
      join(root, "queue-item-1.json"),
      "utf8",
    );

    expect(item.state).toBe("pending");
    expect(files).toEqual([
      "queue-item-1.json",
    ]);
    expect(persisted).not.toContain(knownSecret);
    expect(persisted).not.toContain(entropySecret);
    expect(captureQueueItemSchema.parse(JSON.parse(persisted))).toEqual(
      item,
    );
  });

  it("rejects events from an explicitly marked internal session", async () => {
    const root = await createTemporaryDirectory();
    const queue = new WindowsCaptureQueue(root, {
      idGenerator: () => "queue-item-1",
    });
    await queue.initialize();

    await expect(
      queue.enqueue(createInput(), {
        environment: {
          PROVENLOOP_INTERNAL: "1",
        },
      }),
    ).rejects.toBeInstanceOf(InternalCaptureEventError);
    expect(await queue.list()).toEqual([]);
  });

  it("claims, retries with backoff, and dead-letters at the bound", async () => {
    const root = await createTemporaryDirectory();
    const secret = "ghp_1234567890abcdefghijklmnopqrst";
    let now = new Date("2026-08-29T00:00:00.000Z");
    const queue = new WindowsCaptureQueue(root, {
      claimLeaseMs: 1_000,
      idGenerator: () => "queue-item-1",
      maxAttempts: 2,
      now: () => now,
      retryBaseDelayMs: 500,
      retryMaxDelayMs: 1_000,
    });
    await queue.initialize();
    await queue.enqueue(createInput());

    const firstClaim = await queue.claimNext("worker-1");
    expect(firstClaim).toMatchObject({
      attemptCount: 1,
      state: "claimed",
    });
    expect(firstClaim?.state).toBe("claimed");
    if (firstClaim?.state !== "claimed") {
      throw new Error("Expected the first queue item to be claimed.");
    }
    const retry = await queue.retry(
      firstClaim,
      `temporary ${secret} ` +
        "{\"clientSecretValue\":\"plain-secret\"}",
    );
    expect(retry).toMatchObject({
      attemptCount: 1,
      state: "retry",
    });
    expect(
      retry.state === "retry" ? retry.lastError : "",
    ).not.toContain(secret);
    expect(
      retry.state === "retry" ? retry.lastError : "",
    ).not.toContain("plain-secret");
    expect(await queue.claimNext("worker-1")).toBeUndefined();

    now = new Date(now.getTime() + 500);
    const secondClaim = await queue.claimNext("worker-1");
    expect(secondClaim).toMatchObject({
      attemptCount: 2,
      state: "claimed",
    });
    if (secondClaim?.state !== "claimed") {
      throw new Error("Expected the retry item to be claimed.");
    }
    const deadLetter = await queue.retry(
      secondClaim,
      "persistent failure",
    );
    expect(deadLetter).toMatchObject({
      attemptCount: 2,
      state: "dead-letter",
    });
    await expect(
      queue.acknowledge(secondClaim),
    ).rejects.toBeInstanceOf(InvalidCaptureQueueTransitionError);
  });

  it("recovers an expired claim after restart and prunes old success", async () => {
    const root = await createTemporaryDirectory();
    let now = new Date("2026-08-29T00:00:00.000Z");
    const options = {
      acknowledgedRetentionMs: 1_000,
      claimLeaseMs: 1_000,
      idGenerator: () => "queue-item-1",
      now: () => now,
      retryBaseDelayMs: 500,
    };
    const firstProcess = new WindowsCaptureQueue(root, options);
    await firstProcess.initialize();
    await firstProcess.enqueue(createInput());
    await firstProcess.claimNext("worker-1");

    now = new Date(now.getTime() + 1_001);
    const restartedProcess = new WindowsCaptureQueue(root, options);
    await restartedProcess.initialize();
    const recovered = await restartedProcess.recoverExpiredClaims();
    expect(recovered).toEqual([
      expect.objectContaining({
        state: "retry",
      }),
    ]);

    now = new Date(now.getTime() + 500);
    const replacementClaim = await restartedProcess.claimNext("worker-2");
    if (replacementClaim?.state !== "claimed") {
      throw new Error("Expected the recovered item to be claimed.");
    }
    const acknowledged = await restartedProcess.acknowledge(
      replacementClaim,
    );
    expect(acknowledged.state).toBe("acknowledged");

    now = new Date(now.getTime() + 1_001);
    expect(await restartedProcess.pruneAcknowledged()).toEqual([
      "queue-item-1",
    ]);
    expect(await restartedProcess.list()).toEqual([]);
  });

  it("rejects stale workers after recovery and reclamation", async () => {
    const root = await createTemporaryDirectory();
    let now = new Date("2026-08-29T00:00:00.000Z");
    const queue = new WindowsCaptureQueue(root, {
      claimLeaseMs: 1_000,
      idGenerator: () => "queue-item-1",
      now: () => now,
      retryBaseDelayMs: 500,
    });
    await queue.initialize();
    await queue.enqueue(createInput());
    const staleClaim = await queue.claimNext("worker-1");
    if (staleClaim?.state !== "claimed") {
      throw new Error("Expected the initial item to be claimed.");
    }

    now = new Date(now.getTime() + 1_001);
    await queue.recoverExpiredClaims();
    now = new Date(now.getTime() + 500);
    const activeClaim = await queue.claimNext("worker-2");
    if (activeClaim?.state !== "claimed") {
      throw new Error("Expected the recovered item to be reclaimed.");
    }

    await expect(
      queue.acknowledge(staleClaim),
    ).rejects.toBeInstanceOf(StaleCaptureQueueClaimError);
    await expect(
      queue.retry(staleClaim, "stale retry"),
    ).rejects.toBeInstanceOf(StaleCaptureQueueClaimError);
    expect((await queue.acknowledge(activeClaim)).state).toBe(
      "acknowledged",
    );
  });

  it("surfaces malformed items without deleting in-flight temp files", async () => {
    const root = await createTemporaryDirectory();
    await writeFile(join(root, ".queue-stale.tmp"), "partial", "utf8");
    await writeFile(join(root, "unrelated.tmp"), "keep", "utf8");
    await writeFile(join(root, "corrupt.json"), "{", "utf8");
    const queue = new WindowsCaptureQueue(root);

    await queue.initialize();

    expect(await readdir(root)).toEqual(
      expect.arrayContaining([
        ".queue-stale.tmp",
        "corrupt.json",
        "unrelated.tmp",
      ]),
    );
    await expect(queue.list()).rejects.toBeInstanceOf(
      CorruptCaptureQueueItemError,
    );
  });
});
