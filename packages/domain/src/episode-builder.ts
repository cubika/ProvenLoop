import {
  captureEnvelopeSchema,
  CURRENT_SCHEMA_VERSION,
  episodeAssociationSchema,
  episodeGroupingCorrectionSchema,
  workEpisodeSchema,
  type CaptureEnvelope,
  type EpisodeAssociation,
  type EpisodeAssociationEvidence,
  type EpisodeAssociationSignal,
  type EpisodeGroupingCorrection,
  type JsonValue,
  type WorkEpisode,
} from "@provenloop/contracts";

import { sha256 } from "./digest.js";

export interface WorkEpisodeBuilderOptions {
  readonly associatedThreshold?: number;
  readonly candidateThreshold?: number;
  readonly observationWindowMs?: number;
}

export interface WorkEpisodeBuildResult {
  readonly associations: readonly EpisodeAssociation[];
  readonly episodes: readonly WorkEpisode[];
  readonly ignoredEventIds: readonly string[];
}

interface SessionSummary {
  readonly branches: ReadonlySet<string>;
  readonly commits: ReadonlySet<string>;
  readonly endMs: number;
  readonly events: readonly CaptureEnvelope[];
  readonly files: ReadonlySet<string>;
  readonly issues: ReadonlySet<string>;
  readonly prompts: readonly string[];
  readonly pullRequests: ReadonlySet<string>;
  readonly repoKey: string;
  readonly repoId?: string;
  readonly sessionId: string;
  readonly startMs: number;
  readonly testOrErrors: ReadonlySet<string>;
  readonly tokens: ReadonlySet<string>;
}

interface PairCorrection {
  readonly action: "merge" | "split";
  readonly correctionIds: readonly string[];
  readonly reason?: string;
  readonly timestamp: string;
}

const DEFAULT_ASSOCIATED_THRESHOLD = 0.85;
const DEFAULT_CANDIDATE_THRESHOLD = 0.55;
const DEFAULT_OBSERVATION_WINDOW_MS =
  14 * 24 * 60 * 60 * 1_000;
const STOP_WORDS = new Set([
  "about",
  "after",
  "before",
  "build",
  "change",
  "create",
  "from",
  "implement",
  "into",
  "please",
  "that",
  "this",
  "using",
  "with",
]);

const sorted = (values: Iterable<string>): string[] =>
  [...new Set(values)].sort();

const byTimestampAndId = (
  left: CaptureEnvelope,
  right: CaptureEnvelope,
): number =>
  Date.parse(left.event.timestamp) -
    Date.parse(right.event.timestamp) ||
  left.event.eventId.localeCompare(right.event.eventId);

const pairKey = (left: string, right: string): string =>
  left < right ? `${left}\u0000${right}` : `${right}\u0000${left}`;

const pairIds = (
  left: string,
  right: string,
): readonly [string, string] =>
  left < right ? [left, right] : [right, left];

const overlap = (
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): {
  readonly intersection: readonly string[];
  readonly jaccard: number;
} => {
  const intersection = sorted(
    [...left].filter((value) => right.has(value)),
  );
  const unionSize = new Set([
    ...left,
    ...right,
  ]).size;
  return {
    intersection,
    jaccard: unionSize === 0 ? 0 : intersection.length / unionSize,
  };
};

const boundedStrings = (
  input: JsonValue | undefined,
  acceptedKeys: ReadonlySet<string>,
  depth = 0,
): string[] => {
  if (input === undefined || depth > 4) {
    return [];
  }
  if (Array.isArray(input)) {
    return input.flatMap((value) =>
      boundedStrings(value, acceptedKeys, depth + 1),
    );
  }
  if (input === null || typeof input !== "object") {
    return [];
  }
  const values: string[] = [];
  for (const [
    key,
    value,
  ] of Object.entries(input)) {
    if (
      acceptedKeys.has(key.toLocaleLowerCase("en-US")) &&
      typeof value === "string" &&
      value.trim().length > 0
    ) {
      values.push(value.trim());
    }
    values.push(...boundedStrings(value, acceptedKeys, depth + 1));
  }
  return values;
};

const eventStrings = (envelope: CaptureEnvelope): string[] => {
  const content = envelope.content;
  return [
    content?.message,
    content?.safeError,
    ...(content?.toolResult === undefined
      ? []
      : [
          JSON.stringify(content.toolResult),
        ]),
  ].filter((value): value is string => value !== undefined);
};

const referenceIds = (
  envelope: CaptureEnvelope,
  kind: "issue" | "pull_request",
): string[] => {
  const keySet =
    kind === "issue"
      ? new Set([
          "issue",
          "issueid",
          "issuenumber",
        ])
      : new Set([
          "pr",
          "prid",
          "prnumber",
          "pullrequest",
          "pullrequestid",
          "pullrequestnumber",
        ]);
  const keyed = boundedStrings(
    envelope.event.redactedArguments,
    keySet,
  ).flatMap((value) => value.match(/\d+/gu) ?? []);
  const prefix =
    kind === "issue"
      ? /\bissue\s*#?(\d+)\b/giu
      : /\b(?:pr|pull request)\s*#?(\d+)\b/giu;
  const mentioned = eventStrings(envelope).flatMap((value) =>
    [...value.matchAll(prefix)].map((match) => match[1] ?? ""),
  );
  return sorted([
    ...keyed,
    ...mentioned.filter((value) => value.length > 0),
  ]);
};

const fileNames = (envelope: CaptureEnvelope): string[] => {
  if (envelope.event.eventType !== "file.changed") {
    return [];
  }
  const keyed = boundedStrings(
    envelope.event.redactedArguments,
    new Set([
      "changedfiles",
      "file",
      "filepath",
      "files",
      "path",
    ]),
  );
  const content = eventStrings(envelope);
  return sorted(
    [
      ...keyed,
      ...content,
    ].map((value) =>
      value
        .replaceAll("\\", "/")
        .trim()
        .toLocaleLowerCase("en-US"),
    ),
  );
};

const testOrErrorSignatures = (
  envelope: CaptureEnvelope,
): string[] => {
  if (
    ![
      "build.completed",
      "session.error",
      "test.completed",
      "tool.failed",
    ].includes(envelope.event.eventType)
  ) {
    return [];
  }
  return sorted([
    ...eventStrings(envelope).map((value) =>
      value.trim().toLocaleLowerCase("en-US"),
    ),
    ...(envelope.event.resultDigest === undefined
      ? []
      : [
          envelope.event.resultDigest,
        ]),
  ]);
};

const taskTokens = (prompts: readonly string[]): ReadonlySet<string> =>
  new Set(
    prompts.flatMap((prompt) =>
      prompt
        .toLocaleLowerCase("en-US")
        .match(/[\p{L}\p{N}_-]+/gu)
        ?.filter(
          (token) =>
            token.length >= 3 &&
            !STOP_WORDS.has(token),
        ) ?? [],
    ),
  );

const sessionSummary = (
  sessionId: string,
  events: readonly CaptureEnvelope[],
): SessionSummary => {
  const ordered = [...events].sort(
    byTimestampAndId,
  );
  const repoIds = sorted(
    ordered.flatMap((envelope) => {
      const identity =
        envelope.event.repoId ?? envelope.event.worktree;
      return identity === undefined ? [] : [identity];
    }),
  );
  const repoId = repoIds.length === 1 ? repoIds[0] : undefined;
  const prompts = ordered.flatMap((envelope) =>
    envelope.event.eventType === "prompt.submitted" &&
    envelope.content?.message !== undefined
      ? [envelope.content.message]
      : [],
  );
  return {
    branches: new Set(
      ordered.flatMap((envelope) =>
        envelope.event.branch === undefined
          ? []
          : [envelope.event.branch],
      ),
    ),
    commits: new Set(
      ordered.flatMap((envelope) =>
        envelope.event.eventType !== "git.commit" ||
        envelope.event.commitSha === undefined
          ? []
          : [envelope.event.commitSha],
      ),
    ),
    endMs: Math.max(
      ...ordered.map((envelope) =>
        Date.parse(envelope.event.timestamp),
      ),
    ),
    events: ordered,
    files: new Set(ordered.flatMap(fileNames)),
    issues: new Set(
      ordered.flatMap((envelope) =>
        referenceIds(envelope, "issue"),
      ),
    ),
    prompts,
    pullRequests: new Set(
      ordered.flatMap((envelope) =>
        referenceIds(envelope, "pull_request"),
      ),
    ),
    repoKey:
      repoId ??
      (
        repoIds.length === 0
          ? `unknown:${sessionId}`
          : `ambiguous:${sessionId}`
      ),
    ...(repoId === undefined ? {} : { repoId }),
    sessionId,
    startMs: Math.min(
      ...ordered.map((envelope) =>
        Date.parse(envelope.event.timestamp),
      ),
    ),
    testOrErrors: new Set(
      ordered.flatMap(testOrErrorSignatures),
    ),
    tokens: taskTokens(prompts),
  };
};

const evidence = (
  signal: EpisodeAssociationSignal,
  weight: number,
  detail: string,
  sourceEventIds: readonly string[],
): EpisodeAssociationEvidence => {
  const normalizedSourceEventIds = sorted(sourceEventIds);
  return {
    detail,
    evidenceId:
      `association-evidence-${sha256({
        detail,
        signal,
        sourceEventIds: normalizedSourceEventIds,
        weight,
      }).slice(0, 24)}`,
    signal,
    sourceEventIds: normalizedSourceEventIds,
    weight,
  };
};

const temporalWeight = (
  left: SessionSummary,
  right: SessionSummary,
): number => {
  const gapMs = Math.max(
    0,
    Math.max(left.startMs, right.startMs) -
      Math.min(left.endMs, right.endMs),
  );
  if (gapMs <= 30 * 60 * 1_000) {
    return 0.65;
  }
  if (gapMs <= 2 * 60 * 60 * 1_000) {
    return 0.55;
  }
  if (gapMs <= 6 * 60 * 60 * 1_000) {
    return 0.4;
  }
  if (gapMs <= 24 * 60 * 60 * 1_000) {
    return 0.25;
  }
  return 0;
};

const combinedConfidence = (
  evidenceItems: readonly EpisodeAssociationEvidence[],
): number => {
  const associationWeights = evidenceItems
    .filter((item) => item.signal !== "repository")
    .map((item) => item.weight);
  if (associationWeights.length === 0) {
    return 0;
  }
  return Math.min(
    1,
    1 -
      associationWeights.reduce(
        (remaining, weight) => remaining * (1 - weight),
        1,
      ),
  );
};

const correctionMap = (
  corrections: readonly EpisodeGroupingCorrection[],
): ReadonlyMap<string, PairCorrection> => {
  const pairs = new Map<string, PairCorrection>();
  for (const correction of [...corrections].sort(
    (left, right) =>
      Date.parse(left.timestamp) - Date.parse(right.timestamp) ||
      left.correctionId.localeCompare(right.correctionId),
  )) {
    for (
      let leftIndex = 0;
      leftIndex < correction.sessionIds.length;
      leftIndex += 1
    ) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < correction.sessionIds.length;
        rightIndex += 1
      ) {
        const left = correction.sessionIds[leftIndex];
        const right = correction.sessionIds[rightIndex];
        if (left === undefined || right === undefined) {
          continue;
        }
        const key = pairKey(left, right);
        const previous = pairs.get(key);
        pairs.set(key, {
          action: correction.action,
          correctionIds: [
            ...(previous?.correctionIds ?? []),
            correction.correctionId,
          ],
          ...(correction.reason === undefined
            ? {}
            : {
                reason: correction.reason,
              }),
          timestamp: correction.timestamp,
        });
      }
    }
  }
  return pairs;
};

const pairAssociation = (
  left: SessionSummary,
  right: SessionSummary,
  correction: PairCorrection | undefined,
  thresholds: {
    readonly associated: number;
    readonly candidate: number;
  },
): EpisodeAssociation => {
  const [
    leftSessionId,
    rightSessionId,
  ] = pairIds(left.sessionId, right.sessionId);
  const createdAt =
    correction?.timestamp ??
    new Date(
      Math.min(left.startMs, right.startMs),
    ).toISOString();
  const correctionEvidence =
    correction === undefined
      ? undefined
      : evidence(
          correction.action === "merge"
            ? "explicit_merge"
            : "explicit_split",
          1,
          correction.reason ??
            `User requested an explicit ${correction.action}.`,
          [],
        );
  if (correction?.action === "split") {
    return episodeAssociationSchema.parse({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      associationId:
        `episode-association-${sha256({
          leftSessionId,
          rightSessionId,
        }).slice(0, 24)}`,
      confidence: 1,
      correctionIds: correction.correctionIds,
      createdAt,
      evidence: [
        correctionEvidence,
      ],
      leftSessionId,
      rightSessionId,
      status: "rejected",
    });
  }
  if (correction?.action === "merge") {
    return episodeAssociationSchema.parse({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      associationId:
        `episode-association-${sha256({
          leftSessionId,
          rightSessionId,
        }).slice(0, 24)}`,
      confidence: 1,
      correctionIds: correction.correctionIds,
      createdAt,
      evidence: [
        correctionEvidence,
      ],
      leftSessionId,
      rightSessionId,
      status: "associated",
    });
  }

  const evidenceItems: EpisodeAssociationEvidence[] = [];
  if (left.repoKey !== right.repoKey) {
    evidenceItems.push(
      evidence(
        "repository",
        1,
        `Repository identities differ: ${left.repoKey} vs ${right.repoKey}.`,
        [
          left.events[0]?.event.eventId ?? left.sessionId,
          right.events[0]?.event.eventId ?? right.sessionId,
        ],
      ),
    );
    return episodeAssociationSchema.parse({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      associationId:
        `episode-association-${sha256({
          leftSessionId,
          rightSessionId,
        }).slice(0, 24)}`,
      confidence: 0,
      correctionIds: [],
      createdAt,
      evidence: evidenceItems,
      leftSessionId,
      rightSessionId,
      status: "rejected",
    });
  }

  evidenceItems.push(
    evidence(
      "repository",
      1,
      `Both Sessions resolve to repository ${left.repoKey}.`,
      [
        left.events[0]?.event.eventId ?? left.sessionId,
        right.events[0]?.event.eventId ?? right.sessionId,
      ],
    ),
  );
  const branchOverlap = overlap(left.branches, right.branches);
  if (branchOverlap.intersection.length > 0) {
    evidenceItems.push(
      evidence(
        "branch",
        0.72,
        `Shared branches: ${branchOverlap.intersection.join(", ")}.`,
        [
          ...left.events
            .filter((item) =>
              item.event.branch !== undefined &&
              branchOverlap.intersection.includes(item.event.branch),
            )
            .map((item) => item.event.eventId),
          ...right.events
            .filter((item) =>
              item.event.branch !== undefined &&
              branchOverlap.intersection.includes(item.event.branch),
            )
            .map((item) => item.event.eventId),
        ],
      ),
    );
  }
  const commitOverlap = overlap(left.commits, right.commits);
  if (commitOverlap.intersection.length > 0) {
    evidenceItems.push(
      evidence(
        "commit",
        0.99,
        `Shared commits: ${commitOverlap.intersection.join(", ")}.`,
        [
          ...left.events
            .filter((item) =>
              item.event.eventType === "git.commit" &&
              item.event.commitSha !== undefined &&
              commitOverlap.intersection.includes(item.event.commitSha),
            )
            .map((item) => item.event.eventId),
          ...right.events
            .filter((item) =>
              item.event.eventType === "git.commit" &&
              item.event.commitSha !== undefined &&
              commitOverlap.intersection.includes(item.event.commitSha),
            )
            .map((item) => item.event.eventId),
        ],
      ),
    );
  }
  const pullRequestOverlap = overlap(
    left.pullRequests,
    right.pullRequests,
  );
  if (pullRequestOverlap.intersection.length > 0) {
    evidenceItems.push(
      evidence(
        "pull_request",
        0.98,
        `Shared pull requests: ${pullRequestOverlap.intersection.join(", ")}.`,
        [
          ...left.events.map((item) => item.event.eventId),
          ...right.events.map((item) => item.event.eventId),
        ],
      ),
    );
  }
  const issueOverlap = overlap(left.issues, right.issues);
  if (issueOverlap.intersection.length > 0) {
    evidenceItems.push(
      evidence(
        "issue",
        0.96,
        `Shared issues: ${issueOverlap.intersection.join(", ")}.`,
        [
          ...left.events.map((item) => item.event.eventId),
          ...right.events.map((item) => item.event.eventId),
        ],
      ),
    );
  }
  const fileOverlap = overlap(left.files, right.files);
  if (fileOverlap.intersection.length > 0) {
    evidenceItems.push(
      evidence(
        "changed_file",
        Math.min(0.8, 0.65 + fileOverlap.jaccard * 0.15),
        `Changed-file overlap: ${fileOverlap.intersection.join(", ")}.`,
        [
          ...left.events.map((item) => item.event.eventId),
          ...right.events.map((item) => item.event.eventId),
        ],
      ),
    );
  }
  const testOverlap = overlap(
    left.testOrErrors,
    right.testOrErrors,
  );
  if (testOverlap.intersection.length > 0) {
    evidenceItems.push(
      evidence(
        "test_or_error",
        0.78,
        "The Sessions share a test result or error signature.",
        [
          ...left.events.map((item) => item.event.eventId),
          ...right.events.map((item) => item.event.eventId),
        ],
      ),
    );
  }
  const semanticOverlap = overlap(left.tokens, right.tokens);
  if (semanticOverlap.jaccard >= 0.25) {
    evidenceItems.push(
      evidence(
        "task_semantics",
        Math.min(0.65, 0.4 + semanticOverlap.jaccard * 0.25),
        `Task-token overlap: ${semanticOverlap.intersection.join(", ")}.`,
        [
          ...left.events
            .filter((item) => item.event.eventType === "prompt.submitted")
            .map((item) => item.event.eventId),
          ...right.events
            .filter((item) => item.event.eventType === "prompt.submitted")
            .map((item) => item.event.eventId),
        ],
      ),
    );
  }
  const proximity = temporalWeight(left, right);
  if (proximity > 0) {
    evidenceItems.push(
      evidence(
        "temporal_proximity",
        proximity,
        "The Session time ranges are close.",
        [
          left.events.at(-1)?.event.eventId ?? left.sessionId,
          right.events[0]?.event.eventId ?? right.sessionId,
        ],
      ),
    );
  }
  const confidence = combinedConfidence(evidenceItems);
  return episodeAssociationSchema.parse({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    associationId:
      `episode-association-${sha256({
        leftSessionId,
        rightSessionId,
      }).slice(0, 24)}`,
    confidence,
    correctionIds: [],
    createdAt,
    evidence: evidenceItems,
    leftSessionId,
    rightSessionId,
    status:
      confidence >= thresholds.associated
        ? "associated"
        : confidence >= thresholds.candidate
          ? "candidate"
          : "rejected",
  });
};

const completeLinkClusters = (
  sessionIds: readonly string[],
  associations: readonly EpisodeAssociation[],
): readonly ReadonlySet<string>[] => {
  const associationByPair = new Map(
    associations.map((association) => [
      pairKey(
        association.leftSessionId,
        association.rightSessionId,
      ),
      association,
    ]),
  );
  const clusters = sessionIds.map(
    (sessionId) => new Set([sessionId]),
  );
  const hasSignal = (
    association: EpisodeAssociation,
    signal: EpisodeAssociationSignal,
  ): boolean =>
    association.evidence.some((item) => item.signal === signal);
  const explicitSplits = new Set(
    associations
      .filter((association) =>
        hasSignal(association, "explicit_split"),
      )
      .map((association) =>
        pairKey(
          association.leftSessionId,
          association.rightSessionId,
        ),
      ),
  );
  const mergeClusters = (
    association: EpisodeAssociation,
    requireCompleteLink: boolean,
  ): void => {
    const leftIndex = clusters.findIndex((cluster) =>
      cluster.has(association.leftSessionId),
    );
    const rightIndex = clusters.findIndex((cluster) =>
      cluster.has(association.rightSessionId),
    );
    if (leftIndex === -1 || rightIndex === -1 || leftIndex === rightIndex) {
      return;
    }
    const leftCluster = clusters[leftIndex];
    const rightCluster = clusters[rightIndex];
    if (leftCluster === undefined || rightCluster === undefined) {
      return;
    }
    const splitConflict = [...leftCluster].some((leftSessionId) =>
      [...rightCluster].some((rightSessionId) =>
        explicitSplits.has(pairKey(leftSessionId, rightSessionId)),
      ),
    );
    if (splitConflict) {
      return;
    }
    const completeLink =
      !requireCompleteLink ||
      [...leftCluster].every((leftSessionId) =>
        [...rightCluster].every(
          (rightSessionId) =>
            associationByPair.get(
              pairKey(leftSessionId, rightSessionId),
            )?.status === "associated",
        ),
      );
    if (!completeLink) {
      return;
    }
    const merged = new Set([
      ...leftCluster,
      ...rightCluster,
    ]);
    clusters.splice(
      Math.max(leftIndex, rightIndex),
      1,
    );
    clusters.splice(
      Math.min(leftIndex, rightIndex),
      1,
      merged,
    );
  };
  const explicitMerges = associations
    .filter(
      (association) =>
        association.status === "associated" &&
        hasSignal(association, "explicit_merge"),
    )
    .sort(
      (left, right) =>
        Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
        left.associationId.localeCompare(right.associationId),
    );
  for (const association of explicitMerges) {
    mergeClusters(association, false);
  }
  const associated = associations
    .filter(
      (association) =>
        association.status === "associated" &&
        !hasSignal(association, "explicit_merge"),
    )
    .sort(
      (left, right) =>
        right.confidence - left.confidence ||
        left.associationId.localeCompare(right.associationId),
    );
  for (const association of associated) {
    mergeClusters(association, true);
  }
  return clusters;
};

const outcome = (
  events: readonly CaptureEnvelope[],
  observationWindowMs: number,
): Pick<
  WorkEpisode,
  | "observationWindowEndsAt"
  | "outcome"
  | "outcomeEvidenceIds"
  | "outcomeQualification"
  | "outcomeQualifiedAt"
> => {
  const reverted = events.find(
    (event) => event.event.eventType === "change.reverted",
  );
  if (reverted !== undefined) {
    return {
      outcome: "reverted",
      outcomeEvidenceIds: [
        reverted.event.eventId,
      ],
      outcomeQualification: "qualified",
      outcomeQualifiedAt: reverted.event.timestamp,
    };
  }
  const resultEvents = events.filter((event) =>
    [
      "build.completed",
      "test.completed",
    ].includes(event.event.eventType),
  );
  const latest = resultEvents.at(-1);
  if (latest?.event.completionStatus === "failed") {
    return {
      outcome: "failure",
      outcomeEvidenceIds: [
        latest.event.eventId,
      ],
      outcomeQualification: "qualified",
      outcomeQualifiedAt: latest.event.timestamp,
    };
  }
  if (latest?.event.completionStatus === "succeeded") {
    return {
      observationWindowEndsAt: new Date(
        Date.parse(latest.event.timestamp) + observationWindowMs,
      ).toISOString(),
      outcome: "success",
      outcomeEvidenceIds: [
        latest.event.eventId,
      ],
      outcomeQualification: "censored",
    };
  }
  return {
    outcome: "unknown",
    outcomeEvidenceIds: [],
    outcomeQualification: "open",
  };
};

const episodeFromCluster = (
  cluster: ReadonlySet<string>,
  summaries: ReadonlyMap<string, SessionSummary>,
  associations: readonly EpisodeAssociation[],
  corrections: readonly EpisodeGroupingCorrection[],
  observationWindowMs: number,
): WorkEpisode => {
  const sessionIds = sorted(cluster);
  const events = sessionIds
    .flatMap((sessionId) => summaries.get(sessionId)?.events ?? [])
    .sort(byTimestampAndId);
  const internalAssociations = associations.filter(
    (association) =>
      association.status === "associated" &&
      cluster.has(association.leftSessionId) &&
      cluster.has(association.rightSessionId),
  );
  const repoIds = sorted(
    sessionIds.flatMap((sessionId) => {
      const repoId = summaries.get(sessionId)?.repoId;
      return repoId === undefined ? [] : [repoId];
    }),
  );
  const correctionIds = sorted(
    corrections
      .filter((correction) =>
        correction.sessionIds.some((sessionId) =>
          cluster.has(sessionId),
        ),
      )
      .map((correction) => correction.correctionId),
  );
  const prompt = events.find(
    (event) =>
      event.event.eventType === "prompt.submitted" &&
      event.content?.message?.trim(),
  )?.content?.message;
  const startedAt =
    events[0]?.event.timestamp ??
    "1970-01-01T00:00:00.000Z";
  const finishedAt = events.at(-1)?.event.timestamp ?? startedAt;
  const outcomeState = outcome(events, observationWindowMs);
  return workEpisodeSchema.parse({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    associationConfidence:
      internalAssociations.length === 0
        ? 1
        : Math.min(
            ...internalAssociations.map(
              (association) => association.confidence,
            ),
          ),
    associationEvidenceIds: sorted(
      internalAssociations.flatMap((association) =>
        association.evidence.map((item) => item.evidenceId),
      ),
    ),
    branches: sorted(
      events.flatMap((event) =>
        event.event.branch === undefined
          ? []
          : [event.event.branch],
      ),
    ),
    commitIds: sorted(
      events.flatMap((event) =>
        event.event.eventType !== "git.commit" ||
        event.event.commitSha === undefined
          ? []
          : [event.event.commitSha],
      ),
    ),
    correctionEventIds: sorted([
      ...events
        .filter(
          (event) => event.event.eventType === "user.corrected",
        )
        .map((event) => event.event.eventId),
      ...correctionIds,
    ]),
    episodeId:
      `episode-${sha256({
        sessionIds,
      }).slice(0, 24)}`,
    finishedAt,
    goal:
      prompt?.trim() ||
      `Work in ${repoIds[0] ?? sessionIds[0] ?? "unknown context"}`,
    issueIds: sorted(
      sessionIds.flatMap(
        (sessionId) => [
          ...(summaries.get(sessionId)?.issues ?? []),
        ],
      ),
    ),
    ...outcomeState,
    pullRequestIds: sorted(
      sessionIds.flatMap(
        (sessionId) => [
          ...(summaries.get(sessionId)?.pullRequests ?? []),
        ],
      ),
    ),
    ...(repoIds.length === 1
      ? {
          repoId: repoIds[0],
        }
      : {}),
    sessionIds,
    sourceEventIds: events.map((event) => event.event.eventId),
    startedAt,
  });
};

const threshold = (
  value: number | undefined,
  fallback: number,
  name: string,
): number => {
  const resolved = value ?? fallback;
  if (
    !Number.isFinite(resolved) ||
    resolved < 0 ||
    resolved > 1
  ) {
    throw new RangeError(`${name} must be between 0 and 1.`);
  }
  return resolved;
};

export class WorkEpisodeBuilder {
  readonly #associatedThreshold: number;
  readonly #candidateThreshold: number;
  readonly #observationWindowMs: number;

  public constructor(options: WorkEpisodeBuilderOptions = {}) {
    this.#associatedThreshold = threshold(
      options.associatedThreshold,
      DEFAULT_ASSOCIATED_THRESHOLD,
      "associatedThreshold",
    );
    this.#candidateThreshold = threshold(
      options.candidateThreshold,
      DEFAULT_CANDIDATE_THRESHOLD,
      "candidateThreshold",
    );
    if (this.#candidateThreshold >= this.#associatedThreshold) {
      throw new RangeError(
        "candidateThreshold must be lower than associatedThreshold.",
      );
    }
    this.#observationWindowMs =
      options.observationWindowMs ??
      DEFAULT_OBSERVATION_WINDOW_MS;
    if (
      !Number.isInteger(this.#observationWindowMs) ||
      this.#observationWindowMs <= 0
    ) {
      throw new RangeError(
        "observationWindowMs must be a positive integer.",
      );
    }
  }

  public build(
    input: readonly CaptureEnvelope[],
    corrections: readonly EpisodeGroupingCorrection[] = [],
  ): WorkEpisodeBuildResult {
    const envelopes = input.map((envelope) =>
      captureEnvelopeSchema.parse(envelope),
    );
    const parsedCorrections = corrections.map((correction) =>
      episodeGroupingCorrectionSchema.parse(correction),
    );
    const bySession = new Map<string, CaptureEnvelope[]>();
    const ignoredEventIds: string[] = [];
    for (const envelope of envelopes) {
      const sessionId = envelope.event.sessionId;
      if (sessionId === undefined) {
        ignoredEventIds.push(envelope.event.eventId);
        continue;
      }
      const events = bySession.get(sessionId) ?? [];
      events.push(envelope);
      bySession.set(sessionId, events);
    }
    const summaries = new Map(
      [...bySession.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([sessionId, events]) => [
          sessionId,
          sessionSummary(sessionId, events),
        ]),
    );
    const pairCorrections = correctionMap(parsedCorrections);
    const sessionIds = [...summaries.keys()];
    const associations: EpisodeAssociation[] = [];
    for (
      let leftIndex = 0;
      leftIndex < sessionIds.length;
      leftIndex += 1
    ) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < sessionIds.length;
        rightIndex += 1
      ) {
        const leftId = sessionIds[leftIndex];
        const rightId = sessionIds[rightIndex];
        if (leftId === undefined || rightId === undefined) {
          continue;
        }
        const left = summaries.get(leftId);
        const right = summaries.get(rightId);
        if (left === undefined || right === undefined) {
          continue;
        }
        associations.push(
          pairAssociation(
            left,
            right,
            pairCorrections.get(pairKey(leftId, rightId)),
            {
              associated: this.#associatedThreshold,
              candidate: this.#candidateThreshold,
            },
          ),
        );
      }
    }
    const clusters = completeLinkClusters(
      sessionIds,
      associations,
    );
    const episodes = clusters
      .map((cluster) =>
        episodeFromCluster(
          cluster,
          summaries,
          associations,
          parsedCorrections,
          this.#observationWindowMs,
        ),
      )
      .sort(
        (left, right) =>
          Date.parse(left.startedAt) - Date.parse(right.startedAt) ||
          left.episodeId.localeCompare(right.episodeId),
      );
    return {
      associations,
      episodes,
      ignoredEventIds: sorted(ignoredEventIds),
    };
  }
}
