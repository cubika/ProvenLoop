import {
  mkdtemp,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  CURRENT_SCHEMA_VERSION,
  type EpisodeGroupingCorrection,
} from "@provenloop/contracts";
import { WorkEpisodeProjector } from "@provenloop/host";
import { WindowsCaptureQueue } from "@provenloop/platform-windows";
import { CanonicalSqliteStore } from "@provenloop/storage-sqlite";

const temporaryDirectories: string[] = [];

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(
    join(tmpdir(), "provenloop-episode-projection-"),
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

describe("Work Episode projection", () => {
  it("rebuilds deterministically from canonical capture evidence", async () => {
    const root = await createTemporaryDirectory();
    let sequence = 0;
    const queue = new WindowsCaptureQueue(join(root, "queue"), {
      idGenerator: () => `queue-${sequence += 1}`,
    });
    await queue.initialize();
    const store = new CanonicalSqliteStore(join(root, "canonical.db"));
    try {
      for (const input of [
        {
          adapter: "copilot-cli",
          adapterVersion: "1.0.82-0",
          branch: "feat/episodes",
          content: {
            message: "Implement deterministic Work Episode grouping",
          },
          eventType: "prompt.submitted",
          repoId: "repo-1",
          sessionId: "session-1",
          sourceEventId: "source-1",
          timestamp: "2026-08-30T00:00:00.000Z",
          trust: "user" as const,
        },
        {
          adapter: "copilot-cli",
          adapterVersion: "1.0.82-0",
          branch: "feat/episodes",
          content: {
            message: "Continue deterministic Work Episode grouping",
          },
          eventType: "prompt.submitted",
          repoId: "repo-1",
          sessionId: "session-2",
          sourceEventId: "source-2",
          timestamp: "2026-08-30T00:15:00.000Z",
          trust: "user" as const,
        },
      ]) {
        const item = await queue.enqueue(input);
        expect(store.ingestQueueItem(item).status).toBe("stored");
      }
      const projector = new WorkEpisodeProjector({
        store,
      });

      const first = projector.rebuild();
      const second = projector.rebuild();
      expect(first.persistedEpisodes).toBe(1);
      expect(first.persistedAssociations).toBe(1);
      expect(first.persistedCorrections).toBe(0);
      expect(second.episodes).toEqual(first.episodes);
      expect(store.workEpisodes()).toEqual(first.episodes);
      expect(store.episodeAssociations()).toEqual(
        first.associations,
      );
      const firstAssociation = first.associations[0];
      const firstEpisode = first.episodes[0];
      if (firstAssociation === undefined || firstEpisode === undefined) {
        throw new Error("Expected an initial Episode association.");
      }
      const customAssociation = {
        ...firstAssociation,
        associationId: "custom-valid-association",
      };
      store.replaceWorkEpisodeProjection({
        associations: [
          customAssociation,
        ],
        corrections: [],
        episodes: first.episodes,
      });
      expect(store.episodeAssociations()).toEqual([
        customAssociation,
      ]);

      const database = new DatabaseSync(join(root, "canonical.db"));
      try {
        database
          .prepare(
            `INSERT INTO evidence_links (
               link_id,
               schema_version,
               body_json,
               source_digest,
               created_at
             ) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            "episode-association-unrelated",
            1,
            JSON.stringify({
              schemaVersion: 1,
              linkId: "episode-association-unrelated",
              episodeId: firstEpisode.episodeId,
              evidenceId: "evidence-1",
              kind: "test",
              strength: "direct",
              supportingEvidenceIds: [],
              state: "accepted",
              createdAt: "2026-08-30T00:00:00.000Z",
            }),
            "a".repeat(64),
            "2026-08-30T00:00:00.000Z",
          );
      } finally {
        database.close();
      }

      const correction: EpisodeGroupingCorrection = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        action: "split",
        correctionId: "split-1",
        reason: "The Sessions implemented different requested behaviors.",
        sessionIds: [
          "session-1",
          "session-2",
        ],
        timestamp: "2026-08-30T01:00:00.000Z",
      };
      const corrected = projector.rebuild([
        correction,
      ]);
      expect(corrected.persistedEpisodes).toBe(2);
      expect(corrected.persistedAssociations).toBe(1);
      expect(corrected.persistedCorrections).toBe(1);
      expect(store.workEpisodes()).toHaveLength(2);
      expect(corrected.associations[0]).toMatchObject({
        correctionIds: [
          "split-1",
        ],
        status: "rejected",
      });
      const repeated = projector.rebuild();
      expect(repeated.episodes).toHaveLength(2);
      expect(repeated.persistedCorrections).toBe(1);
      const merged = projector.rebuild([
        {
          schemaVersion: CURRENT_SCHEMA_VERSION,
          action: "merge",
          correctionId: "merge-2",
          reason: "The user later confirmed one shared objective.",
          sessionIds: [
            "session-1",
            "session-2",
          ],
          timestamp: "2026-08-30T02:00:00.000Z",
        },
      ]);
      expect(merged.episodes).toHaveLength(1);
      expect(merged.persistedCorrections).toBe(2);
      expect(
        store
          .episodeGroupingCorrections()
          .map((item) => item.correctionId),
      ).toEqual([
        "split-1",
        "merge-2",
      ]);
      const verification = new DatabaseSync(join(root, "canonical.db"));
      try {
        const retained = verification
          .prepare(
            `SELECT COUNT(*) AS count
               FROM evidence_links
              WHERE link_id = ?`,
          )
          .get("episode-association-unrelated") as Readonly<
          Record<string, unknown>
        >;
        expect(Number(retained.count)).toBe(1);
      } finally {
        verification.close();
      }
    } finally {
      store.close();
    }
  });

  it("returns stored Episodes in chronological offset-aware order", async () => {
    const root = await createTemporaryDirectory();
    let sequence = 0;
    const queue = new WindowsCaptureQueue(join(root, "queue"), {
      idGenerator: () => `queue-${sequence += 1}`,
    });
    await queue.initialize();
    const store = new CanonicalSqliteStore(join(root, "canonical.db"));
    try {
      for (const input of [
        {
          adapter: "copilot-cli",
          adapterVersion: "1.0.82-0",
          eventType: "prompt.submitted",
          repoId: "repo-early",
          sessionId: "session-early",
          sourceEventId: "source-early",
          timestamp: "2026-08-30T02:00:00.000+02:00",
          trust: "user" as const,
        },
        {
          adapter: "copilot-cli",
          adapterVersion: "1.0.82-0",
          eventType: "prompt.submitted",
          repoId: "repo-late",
          sessionId: "session-late",
          sourceEventId: "source-late",
          timestamp: "2026-08-30T01:00:00.000Z",
          trust: "user" as const,
        },
      ]) {
        const item = await queue.enqueue(input);
        expect(store.ingestQueueItem(item).status).toBe("stored");
      }
      new WorkEpisodeProjector({
        store,
      }).rebuild();

      expect(
        store.workEpisodes().map((episode) => episode.sessionIds[0]),
      ).toEqual([
        "session-early",
        "session-late",
      ]);
    } finally {
      store.close();
    }
  });
});
