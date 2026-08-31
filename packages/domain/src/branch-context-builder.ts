import {
  branchContextSchema,
  captureEnvelopeSchema,
  CURRENT_SCHEMA_VERSION,
  workEpisodeSchema,
  type BranchContext,
  type CaptureEnvelope,
  type WorkEpisode,
} from "@provenloop/contracts";

import {
  CommitAncestryIndex,
  commitAncestryEdgesFromEnvelopes,
} from "./commit-ancestry.js";
import { sha256 } from "./digest.js";

export interface BranchContextBuilderOptions {
  readonly ttlMs?: number;
}

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const MATERIAL_EVENT_TYPES = new Set([
  "build.completed",
  "file.changed",
  "git.commit",
  "session.error",
  "test.completed",
  "tool.failed",
]);

const sortedUnique = (values: Iterable<string>): string[] =>
  [...new Set(
    [...values]
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  )].sort();

const labeledValues = (
  message: string | undefined,
  labels: readonly string[],
): string[] => {
  if (message === undefined) {
    return [];
  }
  const labelPattern = labels
    .map((label) => label.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("|");
  const pattern = new RegExp(
    `^\\s*(?:${labelPattern})\\s*:\\s*(.+?)\\s*$`,
    "gimu",
  );
  return [...message.matchAll(pattern)]
    .map((match) => match[1]?.trim() ?? "")
    .filter((value) => value.length > 0);
};

const goalFromMessage = (
  message: string | undefined,
): string | undefined => {
  if (message === undefined) {
    return undefined;
  }
  return message
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(
      (line) =>
        line.length > 0 &&
        !/^(?:accepted decision|constraint|constraints|decision|next|todo|unfinished)\s*:/iu.test(
          line,
        ),
    );
};

const eventState = (envelope: CaptureEnvelope): string | undefined => {
  const event = envelope.event;
  if (event.eventType === "git.commit" && event.commitSha !== undefined) {
    return `Commit ${event.commitSha}`;
  }
  if (event.eventType === "file.changed") {
    const detail = envelope.content?.message?.trim();
    return detail
      ? `Files changed: ${detail}`
      : `Files changed (${event.eventId})`;
  }
  if (
    event.eventType === "build.completed" ||
    event.eventType === "test.completed"
  ) {
    return `${event.eventType}: ${event.completionStatus ?? "observed"}`;
  }
  if (
    event.eventType === "tool.failed" ||
    event.eventType === "session.error"
  ) {
    const detail =
      envelope.content?.safeError?.trim() ??
      envelope.content?.message?.trim();
    return detail
      ? `${event.eventType}: ${detail}`
      : `${event.eventType}: observed`;
  }
  return undefined;
};

const latestTimestamp = (
  envelopes: readonly CaptureEnvelope[],
): string =>
  [...envelopes]
    .sort(
      (left, right) =>
        Date.parse(left.event.timestamp) -
          Date.parse(right.event.timestamp) ||
        left.event.eventId.localeCompare(right.event.eventId),
    )
    .at(-1)?.event.timestamp ??
  new Date(0).toISOString();

const hasExplicitContinuationMarker = (
  envelope: CaptureEnvelope,
): boolean =>
  envelope.event.trust === "user" &&
  labeledValues(envelope.content?.message, [
    "accepted decision",
    "constraint",
    "constraints",
    "decision",
    "next",
    "todo",
    "unfinished",
  ]).length > 0;

export class BranchContextBuilder {
  readonly #ttlMs: number;

  public constructor(options: BranchContextBuilderOptions = {}) {
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isFinite(this.#ttlMs) || this.#ttlMs <= 0) {
      throw new RangeError("Branch Context ttlMs must be positive.");
    }
  }

  public build(
    inputEnvelopes: readonly CaptureEnvelope[],
    inputEpisodes: readonly WorkEpisode[],
  ): readonly BranchContext[] {
    const envelopes = inputEnvelopes.map((envelope) =>
      captureEnvelopeSchema.parse(envelope),
    );
    const episodes = inputEpisodes.map((episode) =>
      workEpisodeSchema.parse(episode),
    );
    const commitAncestry = new CommitAncestryIndex(
      commitAncestryEdgesFromEnvelopes(envelopes),
    );
    const groups = new Map<
      string,
      {
        readonly branch: string;
        readonly episodes: WorkEpisode[];
        readonly repoId: string;
      }
    >();
    for (const episode of episodes) {
      if (episode.repoId === undefined) {
        continue;
      }
      for (const branch of episode.branches) {
        const key = `${episode.repoId}\u0000${branch}`;
        const group = groups.get(key) ?? {
          branch,
          episodes: [],
          repoId: episode.repoId,
        };
        group.episodes.push(episode);
        groups.set(key, group);
      }
    }

    const contexts: BranchContext[] = [];
    for (const group of groups.values()) {
      const candidateSessionIds = new Set(
        group.episodes.flatMap((episode) => episode.sessionIds),
      );
      const candidateEnvelopes = envelopes
        .filter(
          (envelope) =>
            candidateSessionIds.has(
              envelope.event.sessionId ?? "",
            ) &&
            envelope.event.repoId === group.repoId &&
            (
              envelope.event.branch === undefined ||
              envelope.event.branch === group.branch
            ),
        )
        .sort(
          (left, right) =>
            Date.parse(left.event.timestamp) -
              Date.parse(right.event.timestamp) ||
            left.event.eventId.localeCompare(right.event.eventId),
        );
      const headSha = [...candidateEnvelopes]
        .reverse()
        .find((envelope) => envelope.event.commitSha !== undefined)
        ?.event.commitSha;
      if (headSha === undefined) {
        continue;
      }
      const activeSessionIds = new Set(
        [...candidateSessionIds].filter((sessionId) => {
        const commits = candidateEnvelopes.flatMap((envelope) =>
              envelope.event.sessionId === sessionId &&
            envelope.event.commitSha !== undefined
              ? [envelope.event.commitSha]
              : [],
        );
        return commits.some(
            (commit) =>
              commit === headSha ||
              commitAncestry.isAncestor({
                ancestorCommit: commit,
                descendantCommit: headSha,
                repoId: group.repoId,
              }),
        );
        }),
      );
      const activeEpisodes = group.episodes.filter((episode) =>
        episode.sessionIds.some((sessionId) =>
          activeSessionIds.has(sessionId),
        ),
      );
      if (activeEpisodes.length === 0) {
        continue;
      }
      const relevant = candidateEnvelopes.filter((envelope) =>
        activeSessionIds.has(envelope.event.sessionId ?? ""),
      );
      const initialMaterialEvents = relevant.filter(
        (envelope) =>
          MATERIAL_EVENT_TYPES.has(envelope.event.eventType) ||
          hasExplicitContinuationMarker(envelope),
      );
      if (initialMaterialEvents.length === 0) {
        continue;
      }
      const updatedAt = latestTimestamp(initialMaterialEvents);
      const windowStart =
        Date.parse(updatedAt) - this.#ttlMs;
      const windowedRelevant = relevant.filter(
        (envelope) =>
          Date.parse(envelope.event.timestamp) >= windowStart,
      );
      const userMessages = windowedRelevant.filter(
        (envelope) => envelope.event.trust === "user",
      );
      const acceptedDecisions = sortedUnique(
        userMessages.flatMap((envelope) =>
          labeledValues(envelope.content?.message, [
            "accepted decision",
            "decision",
          ]),
        ),
      );
      const explicitConstraints = sortedUnique(
        userMessages.flatMap((envelope) =>
          labeledValues(envelope.content?.message, [
            "constraint",
            "constraints",
          ]),
        ),
      );
      const unfinishedItems = sortedUnique(
        userMessages.flatMap((envelope) =>
          labeledValues(envelope.content?.message, [
            "next",
            "todo",
            "unfinished",
          ]),
        ),
      );
      const implementationState = sortedUnique(
        windowedRelevant.flatMap((envelope) => {
          const state = eventState(envelope);
          return state === undefined ? [] : [state];
        }),
      );
      const verificationEvents = windowedRelevant.filter((envelope) =>
        [
          "build.completed",
          "session.error",
          "test.completed",
          "tool.failed",
        ].includes(envelope.event.eventType),
      );
      const materialEvents = windowedRelevant.filter(
        (envelope) =>
          MATERIAL_EVENT_TYPES.has(envelope.event.eventType) ||
          hasExplicitContinuationMarker(envelope),
      );
      const associatedGoalMessages = new Map<
        string,
        CaptureEnvelope
      >();
      for (const materialEvent of materialEvents) {
        if (hasExplicitContinuationMarker(materialEvent)) {
          associatedGoalMessages.set(
            materialEvent.event.eventId,
            materialEvent,
          );
          continue;
        }
        const sessionId = materialEvent.event.sessionId;
        const preceding = [...userMessages]
          .reverse()
          .find(
            (envelope) =>
              envelope.event.sessionId === sessionId &&
              Date.parse(envelope.event.timestamp) <=
                Date.parse(materialEvent.event.timestamp),
          );
        if (preceding !== undefined) {
          associatedGoalMessages.set(
            preceding.event.eventId,
            preceding,
          );
        }
      }
      const goal = [...associatedGoalMessages.values()]
        .sort(
          (left, right) =>
            Date.parse(right.event.timestamp) -
              Date.parse(left.event.timestamp) ||
            right.event.eventId.localeCompare(left.event.eventId),
        )
        .map((envelope) =>
          goalFromMessage(envelope.content?.message),
        )
        .find((value) => value !== undefined);
      const activeWindowSessionIds = new Set(
        windowedRelevant.flatMap((envelope) =>
          envelope.event.sessionId === undefined
            ? []
            : [envelope.event.sessionId],
        ),
      );
      const contextEpisodes = activeEpisodes.filter((episode) =>
        episode.sessionIds.some((sessionId) =>
          activeWindowSessionIds.has(sessionId),
        ),
      );
      const context = branchContextSchema.parse({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        acceptedDecisions,
        branch: group.branch,
        branchContextId:
          `branch-context-${sha256({
            branch: group.branch,
            headSha,
            repoId: group.repoId,
          }).slice(0, 24)}`,
        expiresAt: new Date(
          Date.parse(updatedAt) + this.#ttlMs,
        ).toISOString(),
        explicitConstraints,
        ...(goal === undefined
          ? {}
          : {
              goal,
            }),
        headSha,
        implementationState,
        recentVerificationEvidenceIds: sortedUnique(
          verificationEvents.map(
            (envelope) => envelope.event.eventId,
          ),
        ),
        repoId: group.repoId,
        sourceEpisodeIds: sortedUnique(
          contextEpisodes.map((episode) => episode.episodeId),
        ),
        sourceEventIds: sortedUnique(
          windowedRelevant.map(
            (envelope) => envelope.event.eventId,
          ),
        ),
        unfinishedItems,
        updatedAt,
      });
      contexts.push(context);
    }
    return contexts.sort(
      (left, right) =>
        left.repoId.localeCompare(right.repoId) ||
        left.branch.localeCompare(right.branch) ||
        left.headSha.localeCompare(right.headSha),
    );
  }
}
