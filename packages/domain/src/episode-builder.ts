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
import { isInternalWorkSource } from "./work-source.js";
import {
  isCreatedCommitEvent,
  isVerificationEvent,
  trustedExecution,
  verificationOutcome,
} from "./verification-proof.js";
import type {
  CommitAncestryResolver,
} from "./commit-ancestry.js";

export interface WorkEpisodeBuilderOptions {
  readonly associatedThreshold?: number;
  readonly candidateThreshold?: number;
  readonly commitAncestry?: CommitAncestryResolver;
  readonly observationWindowMs?: number;
}

export interface WorkEpisodeBuildResult {
  readonly associations: readonly EpisodeAssociation[];
  readonly episodes: readonly WorkEpisode[];
  readonly excludedSessions: readonly {
    readonly reason: "internal_work" | "no_substantive_work";
    readonly sessionId: string;
    readonly sourceEventIds: readonly string[];
  }[];
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
  if (envelope.event.eventType === "prompt.submitted" && !isUserGoal(envelope)) {
    return [];
  }
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

const meaningfulText = (value: string | undefined): boolean =>
  value !== undefined &&
  /[\p{L}\p{N}]/u.test(value) &&
  !/^(?:ok(?:ay)?|yes|no|thanks?(?: you)?|done|hello|hi|嗯|好(?:的)?|谢谢|是的|继续)[.!。！\s]*$/iu.test(value.trim());

const isUserMessage = (envelope: CaptureEnvelope): boolean =>
  envelope.event.trust === "user" &&
  ["prompt.submitted", "user.corrected"].includes(envelope.event.eventType) &&
  Boolean(envelope.content?.message?.trim());

const isUserGoal = (envelope: CaptureEnvelope): boolean =>
  isUserMessage(envelope) && meaningfulText(envelope.content?.message);

const isSubstantiveWork = (envelope: CaptureEnvelope): boolean => {
  if (isInternalWorkSource(envelope.event)) return false;
  if (isUserGoal(envelope)) return true;
  const { event } = envelope;
  if (event.eventType === "agent.message") {
    return event.trust === "model" && meaningfulText(envelope.content?.message);
  }
  if (!trustedExecution(envelope)) return false;
  if (isCreatedCommitEvent(envelope) && event.commitSha !== undefined) return true;
  if (isVerificationEvent(envelope)) return true;
  if (event.eventType === "file.changed") {
    return fileNames(envelope).length > 0 ||
      (event.evidence?.targetPaths?.length ?? 0) > 0;
  }
  if (["tool.started", "tool.completed", "tool.failed"].includes(event.eventType)) {
    return event.toolName !== undefined || event.redactedArguments !== undefined ||
      envelope.content?.toolResult !== undefined;
  }
  return ["issue.linked", "pull_request.updated", "review.received", "change.reverted"].includes(event.eventType) &&
    (eventStrings(envelope).some(meaningfulText) || event.redactedArguments !== undefined);
};

const compactGoal = (value: string): string => {
  const text = value.replace(/\s+/gu, " ").trim();
  const characters = Array.from(text);
  if (characters.length <= 180) return text;
  const prefix = characters.slice(0, 179).join("");
  const sentence = prefix.match(/^(.{40,}[.!?。！？])(?:\s|$)/u)?.[1];
  if (sentence !== undefined) return `${sentence}…`;
  const wordBoundary = prefix.lastIndexOf(" ");
  return `${wordBoundary >= 120 ? prefix.slice(0, wordBoundary) : prefix}…`;
};

const activityGoal = (envelope: CaptureEnvelope): string => {
  const { event } = envelope;
  if (event.eventType === "agent.message") {
    return compactGoal(`Recorded assistant response: ${envelope.content?.message ?? ""}`);
  }
  if (event.eventType === "file.changed") {
    const files = event.evidence?.targetPaths ?? fileNames(envelope);
    return compactGoal(`Changes recorded in ${files.join(", ")}`);
  }
  if (event.eventType === "git.commit") return compactGoal(`Commit recorded: ${event.commitSha ?? ""}`);
  if (isVerificationEvent(envelope)) {
    return compactGoal(`Recorded ${event.eventType.split(".")[0]} result${event.toolName === undefined ? "" : ` from ${event.toolName}`}`);
  }
  if (event.eventType.startsWith("tool.")) {
    return compactGoal(`Captured tool activity${event.toolName === undefined ? "" : `: ${event.toolName}`}`);
  }
  return compactGoal(`Recorded ${event.eventType.replaceAll(".", " ")}: ${envelope.content?.message ?? "work activity"}`);
};

const sourceWasTruncated = (envelope: CaptureEnvelope): boolean =>
  [...envelope.redaction.truncatedPaths, ...(envelope.event.captureQuality?.truncatedFields ?? [])]
    .some((path) => path === "message" || path === "content" || path.endsWith(".message") || path.endsWith(".content"));

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
        envelope.event.repoId ??
        (envelope.event.repositoryState === "known_repo" ? envelope.event.worktree : undefined);
      return identity === undefined ? [] : [identity];
    }),
  );
  const repoId = repoIds.length === 1 ? repoIds[0] : undefined;
  const prompts = ordered.flatMap((envelope) =>
    isUserGoal(envelope) && envelope.content?.message !== undefined
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
        !isCreatedCommitEvent(envelope) ||
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
  commitAncestry: CommitAncestryResolver | undefined,
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
  const ancestryRepoId =
    left.repoId !== undefined &&
    left.repoId === right.repoId
      ? left.repoId
      : undefined;
  const ancestryRelations =
    ancestryRepoId === undefined || commitAncestry === undefined
      ? []
      : [...left.commits].flatMap((leftCommit) =>
          [...right.commits].flatMap((rightCommit) => {
            if (
              commitAncestry.isAncestor({
                ancestorCommit: leftCommit,
                descendantCommit: rightCommit,
                repoId: ancestryRepoId,
              })
            ) {
              return [
                `${leftCommit} -> ${rightCommit}`,
              ];
            }
            if (
              commitAncestry.isAncestor({
                ancestorCommit: rightCommit,
                descendantCommit: leftCommit,
                repoId: ancestryRepoId,
              })
            ) {
              return [
                `${rightCommit} -> ${leftCommit}`,
              ];
            }
            return [];
          }),
        );
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
            .filter(isUserGoal)
            .map((item) => item.event.eventId),
          ...right.events
            .filter(isUserGoal)
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
  const ancestryCorroborated = evidenceItems.some((item) =>
    [
      "changed_file",
      "issue",
      "pull_request",
      "task_semantics",
      "temporal_proximity",
      "test_or_error",
    ].includes(item.signal),
  );
  if (ancestryRelations.length > 0 && ancestryCorroborated) {
    evidenceItems.push(
      evidence(
        "commit_ancestry",
        0.55,
        `Commit ancestry connects the Sessions: ${ancestryRelations.join(", ")}.`,
        [
          ...left.events
            .filter(
              (item) =>
                item.event.eventType === "git.commit" &&
                item.event.commitSha !== undefined,
            )
            .map((item) => item.event.eventId),
          ...right.events
            .filter(
              (item) =>
                item.event.eventType === "git.commit" &&
                item.event.commitSha !== undefined,
            )
            .map((item) => item.event.eventId),
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
    (event) =>
      event.event.eventType === "change.reverted" &&
      trustedExecution(event),
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
  const resultEvents = events.filter(isVerificationEvent);
  const latest = resultEvents.at(-1);
  if (latest !== undefined && verificationOutcome(latest) === "failed") {
    return {
      outcome: "failure",
      outcomeEvidenceIds: [
        latest.event.eventId,
      ],
      outcomeQualification: "qualified",
      outcomeQualifiedAt: latest.event.timestamp,
    };
  }
  if (latest !== undefined && verificationOutcome(latest) === "succeeded") {
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
  const prompt = events.find(isUserGoal);
  const goalSource = prompt ?? events.find(isSubstantiveWork);
  if (goalSource === undefined) {
    throw new Error("An Episode requires substantive work evidence.");
  }
  const startedAt =
    events[0]?.event.timestamp ??
    "1970-01-01T00:00:00.000Z";
  const lastActivityAt = events.at(-1)?.event.timestamp ?? startedAt;
  const closures = sessionIds.flatMap((sessionId) => {
    const sessionEvents = summaries.get(sessionId)?.events ?? [];
    const closure = sessionEvents.findLast((envelope) =>
      envelope.event.eventType === "session.ended" &&
      ["system", "user"].includes(envelope.event.trust),
    );
    if (closure === undefined || sessionEvents.some((envelope) =>
      Date.parse(envelope.event.timestamp) > Date.parse(closure.event.timestamp) &&
      (isSubstantiveWork(envelope) || envelope.event.eventType === "session.started"),
    )) return [];
    return [closure];
  });
  const finishedAt = closures.length === sessionIds.length
    ? [...closures].sort(byTimestampAndId).at(-1)?.event.timestamp
    : undefined;
  const substantiveEvents = events.filter(isSubstantiveWork);
  const repositoryState = repoIds.length === 1 ? "known_repo"
    : repoIds.length === 0 && substantiveEvents.every((envelope) =>
      envelope.event.repositoryState === "known_outside_repo",
    ) ? "known_outside_repo" : "unknown";
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
        !isCreatedCommitEvent(event) ||
        event.event.commitSha === undefined
          ? []
          : [event.event.commitSha],
      ),
    ),
    closureSourceEventIds: finishedAt === undefined ? [] : closures.map((envelope) => envelope.event.eventId),
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
    ...(finishedAt === undefined ? {} : { finishedAt }),
    goal: prompt === undefined
      ? activityGoal(goalSource)
      : compactGoal(prompt.content?.message ?? ""),
    goalSource: prompt === undefined ? "activity_summary" : "user_prompt",
    goalSourceEventIds: [goalSource.event.eventId],
    goalSourceTruncated: sourceWasTruncated(goalSource),
    issueIds: sorted(
      sessionIds.flatMap(
        (sessionId) => [
          ...(summaries.get(sessionId)?.issues ?? []),
        ],
      ),
    ),
    lastActivityAt,
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
    repositoryState,
    sessionIds,
    sourceEventIds: events.map((event) => event.event.eventId),
    startedAt,
    worktrees: sorted(events.flatMap((envelope) =>
      envelope.event.worktree === undefined ? [] : [envelope.event.worktree],
    )),
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
  readonly #commitAncestry: CommitAncestryResolver | undefined;
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
    this.#commitAncestry = options.commitAncestry;
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
    const excludedSessions: WorkEpisodeBuildResult["excludedSessions"][number][] = [];
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
    for (const [sessionId, events] of bySession) {
      const internalWork = !events.some(isUserMessage) &&
        events.some((envelope) => isInternalWorkSource(envelope.event));
      if (internalWork || !events.some(isSubstantiveWork)) {
        const sourceEventIds = sorted(events.map((envelope) => envelope.event.eventId));
        excludedSessions.push({
          reason: internalWork ? "internal_work" : "no_substantive_work",
          sessionId,
          sourceEventIds,
        });
        ignoredEventIds.push(...sourceEventIds);
        bySession.delete(sessionId);
      } else {
        bySession.set(sessionId, events.filter((envelope) => {
          if (!isInternalWorkSource(envelope.event)) return true;
          ignoredEventIds.push(envelope.event.eventId);
          return false;
        }));
      }
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
            this.#commitAncestry,
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
      excludedSessions: excludedSessions.sort((left, right) => left.sessionId.localeCompare(right.sessionId)),
      ignoredEventIds: sorted(ignoredEventIds),
    };
  }
}
