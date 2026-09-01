import {
  mkdtemp,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CURRENT_SCHEMA_VERSION,
  type WorkEpisode,
} from "@provenloop/contracts";
import {
  CorrectionCaptureProjector,
  WorkEpisodeProjector,
} from "@provenloop/host";
import { WindowsCaptureQueue } from "@provenloop/platform-windows";
import { CanonicalSqliteStore } from "@provenloop/storage-sqlite";

const temporaryDirectories: string[] = [];

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(
    join(tmpdir(), "provenloop-correction-capture-"),
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

const correctionMessage = [
  "Violated Constraint: Inspect package scripts before choosing a test runner",
  "Expected Behavior: Run the targeted Vitest command",
  "Trigger: package validation",
  "Task Family: testing",
  "Subsystem: test-runner",
  "Scope: repository",
].join("\n");

const workEpisode = (input: {
  readonly correctionEventIds?: readonly string[];
  readonly episodeId: string;
  readonly sourceEventIds: readonly string[];
  readonly startedAt: string;
}): WorkEpisode => ({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  associationConfidence: 1,
  associationEvidenceIds: [],
  branches: [
    "feat/testing",
  ],
  commitIds: [],
  correctionEventIds: [
    ...(input.correctionEventIds ?? []),
  ],
  episodeId: input.episodeId,
  finishedAt: new Date(
    Date.parse(input.startedAt) + 60_000,
  ).toISOString(),
  goal: "Run package validation",
  issueIds: [],
  outcome: "success",
  outcomeEvidenceIds: [],
  outcomeQualification: "censored",
  pullRequestIds: [],
  repoId: "repo-1",
  sessionIds: [
    `session-${input.episodeId}`,
  ],
  sourceEventIds: [
    ...input.sourceEventIds,
  ],
  startedAt: input.startedAt,
});

describe("Correction capture projection", () => {
  it("persists stable Correction Keys and pre-outcome Opportunities", async () => {
    const root = await createTemporaryDirectory();
    let sequence = 0;
    const queue = new WindowsCaptureQueue(join(root, "queue"), {
      idGenerator: () => `queue-${sequence += 1}`,
    });
    await queue.initialize();
    const store = new CanonicalSqliteStore(
      join(root, "canonical.db"),
    );
    try {
      const queued = [];
      for (const input of [
        {
          adapter: "copilot-cli",
          adapterVersion: "1.0.82-0",
          branch: "feat/testing",
          content: {
            message: correctionMessage,
          },
          eventType: "user.corrected",
          repoId: "repo-1",
          sessionId: "session-source",
          sourceEventId: "correction-source",
          timestamp: "2026-09-01T00:10:00.000Z",
          trust: "user" as const,
        },
        {
          adapter: "copilot-cli",
          adapterVersion: "1.0.82-0",
          branch: "feat/testing",
          completionStatus: "succeeded" as const,
          eventType: "test.completed",
          repoId: "repo-1",
          sessionId: "session-source",
          sourceEventId: "verification-source",
          timestamp: "2026-09-01T00:20:00.000Z",
          trust: "tool" as const,
        },
        {
          adapter: "copilot-cli",
          adapterVersion: "1.0.82-0",
          branch: "feat/testing",
          content: {
            message: [
              "Run package validation",
              "Task Family: testing",
              "Subsystem: test-runner",
            ].join("\n"),
          },
          eventType: "prompt.submitted",
          repoId: "repo-1",
          sessionId: "session-next",
          sourceEventId: "prompt-next",
          timestamp: "2026-09-02T00:00:00.000Z",
          trust: "user" as const,
        },
      ]) {
        const item = await queue.enqueue(input);
        queued.push(item);
        expect(store.ingestQueueItem(item).status).toBe("stored");
      }
      const sourceCorrectionId =
        queued[0]?.envelope.event.eventId;
      const verificationId =
        queued[1]?.envelope.event.eventId;
      const nextPromptId =
        queued[2]?.envelope.event.eventId;
      if (
        sourceCorrectionId === undefined ||
        verificationId === undefined ||
        nextPromptId === undefined
      ) {
        throw new Error("Expected queued correction fixtures.");
      }
      store.replaceWorkEpisodeProjection({
        associations: [],
        corrections: [],
        episodes: [
          workEpisode({
            correctionEventIds: [
              sourceCorrectionId,
            ],
            episodeId: "episode-source",
            sourceEventIds: [
              sourceCorrectionId,
              verificationId,
            ],
            startedAt: "2026-09-01T00:00:00.000Z",
          }),
          workEpisode({
            episodeId: "episode-next",
            sourceEventIds: [
              nextPromptId,
            ],
            startedAt: "2026-09-02T00:00:00.000Z",
          }),
        ],
      });

      const first = new CorrectionCaptureProjector({
        store,
      }).rebuild();
      const second = new CorrectionCaptureProjector({
        store,
      }).rebuild();

      expect(store.health().userVersion).toBe(6);
      expect(first).toMatchObject({
        issues: [],
        persistedCorrectionKeys: 1,
        persistedOpportunities: 1,
      });
      expect(first.correctionKeys[0]).toMatchObject({
        sourceCorrectionEventIds: [
          sourceCorrectionId,
        ],
        verificationEvidenceIds: [
          verificationId,
        ],
      });
      expect(first.opportunities[0]).toMatchObject({
        applicable: true,
        correctionRepeated: false,
        createdAt: "2026-09-02T00:00:00.000Z",
        episodeId: "episode-next",
        knowledgeAppliedBeforeCorrection: false,
        knowledgeAvailableBeforeCorrection: false,
        outcomeKnown: false,
      });
      expect(second.correctionKeys).toEqual(first.correctionKeys);
      expect(second.opportunities).toEqual(first.opportunities);
      expect(store.correctionKeys()).toEqual(first.correctionKeys);
      expect(store.correctionOpportunities()).toEqual(
        first.opportunities,
      );
    } finally {
      store.close();
    }
  });

  it("removes dependent correction projections with source deletion", async () => {
    const root = await createTemporaryDirectory();
    let sequence = 0;
    const queue = new WindowsCaptureQueue(join(root, "queue"), {
      idGenerator: () => `queue-${sequence += 1}`,
    });
    await queue.initialize();
    const store = new CanonicalSqliteStore(
      join(root, "canonical.db"),
    );
    try {
      const correction = await queue.enqueue({
        adapter: "copilot-cli",
        adapterVersion: "1.0.82-0",
        branch: "feat/testing",
        content: {
          message: correctionMessage,
        },
        eventType: "user.corrected",
        repoId: "repo-1",
        sessionId: "session-source",
        sourceEventId: "correction-source",
        timestamp: "2026-09-01T00:10:00.000Z",
        trust: "user",
      });
      const verification = await queue.enqueue({
        adapter: "copilot-cli",
        adapterVersion: "1.0.82-0",
        branch: "feat/testing",
        completionStatus: "succeeded",
        eventType: "test.completed",
        repoId: "repo-1",
        sessionId: "session-source",
        sourceEventId: "verification-source",
        timestamp: "2026-09-01T00:20:00.000Z",
        trust: "tool",
      });
      const nextPrompt = await queue.enqueue({
        adapter: "copilot-cli",
        adapterVersion: "1.0.82-0",
        branch: "feat/testing",
        content: {
          message: [
            "Run package validation",
            "Task Family: testing",
            "Subsystem: test-runner",
          ].join("\n"),
        },
        eventType: "prompt.submitted",
        repoId: "repo-1",
        sessionId: "session-next",
        sourceEventId: "prompt-next",
        timestamp: "2026-09-02T00:00:00.000Z",
        trust: "user",
      });
      for (const item of [
        correction,
        verification,
        nextPrompt,
      ]) {
        expect(store.ingestQueueItem(item).status).toBe("stored");
      }
      store.replaceWorkEpisodeProjection({
        associations: [],
        corrections: [],
        episodes: [
          workEpisode({
            correctionEventIds: [
              correction.envelope.event.eventId,
            ],
            episodeId: "episode-source",
            sourceEventIds: [
              correction.envelope.event.eventId,
              verification.envelope.event.eventId,
            ],
            startedAt: "2026-09-01T00:00:00.000Z",
          }),
          workEpisode({
            episodeId: "episode-next",
            sourceEventIds: [
              nextPrompt.envelope.event.eventId,
            ],
            startedAt: "2026-09-02T00:00:00.000Z",
          }),
        ],
      });
      const projection = new CorrectionCaptureProjector({
        store,
      }).rebuild();
      const keyId = projection.correctionKeys[0]?.correctionKeyId;
      const opportunityId =
        projection.opportunities[0]?.opportunityId;
      if (keyId === undefined || opportunityId === undefined) {
        throw new Error("Expected correction projection identifiers.");
      }
      const deletion = store.beginDeletion(
        {
          targetId: correction.envelope.event.eventId,
          targetType: "source",
        },
        "delete-correction-source",
      );
      const mutation = store.deleteCanonicalTarget(
        deletion.deletionId,
        {
          targetId: correction.envelope.event.eventId,
          targetType: "source",
        },
      );
      new WorkEpisodeProjector({
        store,
      }).rebuild(undefined, {
        allowDuringDeletion: true,
      });
      new CorrectionCaptureProjector({
        store,
      }).rebuild({
        allowDuringDeletion: true,
      });

      expect(mutation.dependentIds).toEqual(
        expect.arrayContaining([
          keyId,
          opportunityId,
        ]),
      );
      expect(store.correctionKeys()).toEqual([]);
      expect(store.correctionOpportunities()).toEqual([]);
      expect(
        store.remainingIdentifiers(
          new Set([
            keyId,
            opportunityId,
          ]),
        ),
      ).toEqual([]);
    } finally {
      store.close();
    }
  });
});
