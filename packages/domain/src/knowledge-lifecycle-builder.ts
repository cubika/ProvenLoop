import {
  captureEnvelopeSchema,
  correctionKeySchema,
  correctionOpportunitySchema,
  CURRENT_SCHEMA_VERSION,
  feedbackEventSchema,
  knowledgeCandidateSchema,
  workEpisodeSchema,
  type CaptureEnvelope,
  type CorrectionKey,
  type CorrectionOpportunity,
  type EvidenceMark,
  type EvidenceTier,
  type FeedbackEvent,
  type KnowledgeCandidate,
  type WorkEpisode,
} from "@provenloop/contracts";

import { sha256 } from "./digest.js";

export interface KnowledgeLifecycleBuildInput {
  readonly correctionKeys: readonly CorrectionKey[];
  readonly correctionOpportunities: readonly CorrectionOpportunity[];
  readonly envelopes: readonly CaptureEnvelope[];
  readonly feedbackEvents: readonly FeedbackEvent[];
  readonly workEpisodes: readonly WorkEpisode[];
}

export interface KnowledgeLifecycleBuildResult {
  readonly candidates: readonly KnowledgeCandidate[];
}

interface KnowledgeVersion {
  readonly candidateId: string;
  readonly correctionKeys: readonly CorrectionKey[];
  readonly expectedBehavior: string;
  readonly topicKey: string;
}

const normalizeDisplay = (value: string): string =>
  value.normalize("NFKC").replaceAll(/\s+/gu, " ").trim();

const normalizeIdentity = (value: string): string =>
  normalizeDisplay(value).toLocaleLowerCase("en-US");

const sortedUnique = (values: Iterable<string>): string[] =>
  [...new Set(values)].sort();

const byTimestampAndId = (
  left: FeedbackEvent,
  right: FeedbackEvent,
): number =>
  Date.parse(left.timestamp) - Date.parse(right.timestamp) ||
  left.feedbackId.localeCompare(right.feedbackId);

const latestTimestamp = (
  timestamps: readonly string[],
): string | undefined =>
  [...timestamps].sort(
    (left, right) =>
      Date.parse(left) - Date.parse(right) ||
      left.localeCompare(right),
  ).at(-1);

const earliestTimestamp = (
  timestamps: readonly string[],
): string | undefined =>
  [...timestamps].sort(
    (left, right) =>
      Date.parse(left) - Date.parse(right) ||
      left.localeCompare(right),
  )[0];

export const correctionKnowledgeTopicKey = (
  key: CorrectionKey,
): string =>
  `correction:${sha256({
    scope: key.scope,
    scopeId: key.scopeId,
    subsystem:
      key.subsystem === undefined
        ? undefined
        : normalizeIdentity(key.subsystem),
    taskFamily:
      key.taskFamily === undefined
        ? undefined
        : normalizeIdentity(key.taskFamily),
    trigger: normalizeIdentity(key.trigger),
    violatedConstraint: normalizeIdentity(key.violatedConstraint),
  }).slice(0, 24)}`;

const correctionKnowledgeId = (
  topicKey: string,
  expectedBehavior: string,
): string =>
  `correction-knowledge-${sha256({
    expectedBehavior: normalizeIdentity(expectedBehavior),
    topicKey,
  }).slice(0, 24)}`;

const versionsFromKeys = (
  keys: readonly CorrectionKey[],
): readonly KnowledgeVersion[] => {
  const topics = new Map<string, Map<string, CorrectionKey[]>>();
  for (const key of keys) {
    const topicKey = correctionKnowledgeTopicKey(key);
    const expectedIdentity = normalizeIdentity(key.expectedBehavior);
    const topic = topics.get(topicKey) ?? new Map();
    const version = topic.get(expectedIdentity) ?? [];
    version.push(key);
    topic.set(expectedIdentity, version);
    topics.set(topicKey, topic);
  }
  return [...topics.entries()]
    .flatMap(([topicKey, versions]) =>
      [...versions.values()].map((versionKeys) => {
        const ordered = [...versionKeys].sort(
          (left, right) =>
            Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
            left.correctionKeyId.localeCompare(right.correctionKeyId),
        );
        const first = ordered[0];
        if (first === undefined) {
          throw new Error(`Knowledge topic ${topicKey} has no keys.`);
        }
        return {
          candidateId: correctionKnowledgeId(
            topicKey,
            first.expectedBehavior,
          ),
          correctionKeys: ordered,
          expectedBehavior: first.expectedBehavior,
          topicKey,
        };
      }),
    )
    .sort(
      (left, right) =>
        left.topicKey.localeCompare(right.topicKey) ||
        left.candidateId.localeCompare(right.candidateId),
    );
};

const evidenceMarks = (
  correctionEventIds: readonly string[],
  verificationEvidenceIds: readonly string[],
): readonly EvidenceMark[] => {
  const marks: EvidenceMark[] = [];
  if (verificationEvidenceIds.length > 0) {
    marks.push("externally_verified");
  }
  if (
    verificationEvidenceIds.length > 0 &&
    correctionEventIds.length >= 2
  ) {
    marks.push("repeated_evidence");
  }
  return marks;
};

const tierFromMarks = (
  marks: readonly EvidenceMark[],
): EvidenceTier =>
  marks.includes("repeated_evidence")
    ? "repeated_evidence"
    : marks.includes("externally_verified")
      ? "externally_verified"
      : marks.includes("user_confirmed")
        ? "user_confirmed"
        : "inferred";

const directCounterevidence = (
  envelopes: readonly CaptureEnvelope[],
  sourceEvidenceIds: ReadonlySet<string>,
  createdAt: string,
): readonly CaptureEnvelope[] =>
  envelopes.filter(
    (envelope) =>
      Date.parse(envelope.event.timestamp) >= Date.parse(createdAt) &&
      envelope.event.parentEventId !== undefined &&
      sourceEvidenceIds.has(envelope.event.parentEventId) &&
      (
        envelope.event.eventType === "change.reverted" ||
        (
          (
            envelope.event.eventType === "test.completed" ||
            envelope.event.eventType === "build.completed"
          ) &&
          envelope.event.completionStatus === "failed"
        )
      ) &&
      envelope.event.trust !== "model" &&
      envelope.event.trust !== "external-content",
  );

const sourceEpisodes = (
  sourceEvidenceIds: ReadonlySet<string>,
  episodes: readonly WorkEpisode[],
): readonly string[] =>
  sortedUnique(
    episodes.flatMap((episode) =>
      episode.sourceEventIds.some((eventId) =>
        sourceEvidenceIds.has(eventId),
      )
        ? [episode.episodeId]
        : [],
    ),
  );

const appliesWhen = (
  key: CorrectionKey,
): readonly string[] => [
  key.trigger,
  ...(key.taskFamily === undefined
    ? []
    : [
        `Task Family: ${key.taskFamily}`,
      ]),
  ...(key.subsystem === undefined
    ? []
    : [
        `Subsystem: ${key.subsystem}`,
      ]),
];

const applyFeedback = (
  candidate: KnowledgeCandidate,
  feedback: FeedbackEvent,
): KnowledgeCandidate => {
  const marks = new Set(candidate.evidenceMarks);
  let state = candidate.state;
  let evidenceTier = candidate.evidenceTier;
  let scope = candidate.scope;
  let scopeId = candidate.scopeId;
  let expiresAt = candidate.expiresAt;
  let applied = candidate.utility.applied;
  let harmful = candidate.utility.harmful;
  let helpful = candidate.utility.helpful;
  switch (feedback.kind) {
    case "confirm":
      marks.add("user_confirmed");
      evidenceTier = tierFromMarks([...marks]);
      state =
        marks.has("externally_verified") ||
        marks.has("repeated_evidence")
          ? "active"
          : "candidate";
      break;
    case "strengthen":
      applied += 1;
      helpful += 1;
      break;
    case "correct":
      applied += 1;
      harmful += 1;
      state = "disputed";
      evidenceTier = "disputed";
      break;
    case "conflict":
    case "weaken":
      state = "disputed";
      evidenceTier = "disputed";
      break;
    case "stale":
    case "revoke":
      state = "archived";
      expiresAt = feedback.timestamp;
      break;
    case "set_scope":
      if (feedback.scopeChange !== undefined) {
        scope = feedback.scopeChange.scope;
        scopeId = feedback.scopeChange.scopeId;
      }
      break;
    case "irrelevant":
    case "mute_session":
      break;
  }
  const {
    expiresAt: previousExpiresAt,
    scopeId: previousScopeId,
    ...withoutOptional
  } = candidate;
  void previousExpiresAt;
  void previousScopeId;
  return knowledgeCandidateSchema.parse({
    ...withoutOptional,
    evidenceMarks: sortedUnique(marks),
    evidenceTier,
    ...(expiresAt === undefined
      ? {}
      : {
          expiresAt,
        }),
    scope,
    ...(scopeId === undefined
      ? {}
      : {
          scopeId,
        }),
    state,
    utility: {
      applied,
      harmful,
      helpful,
    },
    validatedAt: feedback.timestamp,
  });
};

const reconcileTopicVersions = (
  input: readonly KnowledgeCandidate[],
): readonly KnowledgeCandidate[] => {
  const byTopic = new Map<string, KnowledgeCandidate[]>();
  for (const candidate of input) {
    const topic = byTopic.get(candidate.topicKey) ?? [];
    topic.push(candidate);
    byTopic.set(candidate.topicKey, topic);
  }
  const result: KnowledgeCandidate[] = [];
  for (const candidates of byTopic.values()) {
    const active = candidates
      .filter((candidate) => candidate.state === "active")
      .sort(
        (left, right) =>
          Date.parse(
            right.validatedAt ?? right.createdAt,
          ) -
            Date.parse(left.validatedAt ?? left.createdAt) ||
          right.knowledgeId.localeCompare(left.knowledgeId),
      );
    const selected = active[0];
    const superseded = new Set(
      active.slice(1).map((candidate) => candidate.knowledgeId),
    );
    const previous = active[1];
    for (const candidate of candidates) {
      const {
        supersedes: previousSupersedes,
        ...withoutSupersedes
      } = candidate;
      void previousSupersedes;
      result.push(
        knowledgeCandidateSchema.parse({
          ...withoutSupersedes,
          ...(selected?.knowledgeId === candidate.knowledgeId &&
          previous !== undefined
            ? {
                supersedes: previous.knowledgeId,
              }
            : {}),
          state: superseded.has(candidate.knowledgeId)
            ? "superseded"
            : candidate.state,
        }),
      );
    }
  }
  return result.sort((left, right) =>
    left.knowledgeId.localeCompare(right.knowledgeId),
  );
};

export class KnowledgeLifecycleBuilder {
  public build(
    input: KnowledgeLifecycleBuildInput,
  ): KnowledgeLifecycleBuildResult {
    const correctionKeys = input.correctionKeys.map((key) =>
      correctionKeySchema.parse(key),
    );
    const opportunities = input.correctionOpportunities.map(
      (opportunity) =>
        correctionOpportunitySchema.parse(opportunity),
    );
    const envelopes = input.envelopes.map((envelope) =>
      captureEnvelopeSchema.parse(envelope),
    );
    const feedbackEvents = input.feedbackEvents
      .map((event) => feedbackEventSchema.parse(event))
      .sort(byTimestampAndId);
    const workEpisodes = input.workEpisodes.map((episode) =>
      workEpisodeSchema.parse(episode),
    );
    const eventsById = new Map(
      envelopes.map((envelope) => [
        envelope.event.eventId,
        envelope,
      ]),
    );
    const episodesById = new Map(
      workEpisodes.map((episode) => [
        episode.episodeId,
        episode,
      ]),
    );
    const versions = versionsFromKeys(correctionKeys);
    const candidates = versions.map((version) => {
      const keyIds = new Set(
        version.correctionKeys.map((key) => key.correctionKeyId),
      );
      const correctionEventIds = sortedUnique(
        version.correctionKeys.flatMap(
          (key) => key.sourceCorrectionEventIds,
        ),
      );
      const verificationEvidenceIds = sortedUnique(
        version.correctionKeys.flatMap(
          (key) => key.verificationEvidenceIds,
        ),
      );
      const baseEvidenceIds = new Set([
        ...correctionEventIds,
        ...verificationEvidenceIds,
      ]);
      const createdAt =
        earliestTimestamp(
          version.correctionKeys.map((key) => key.createdAt),
        ) ?? new Date(0).toISOString();
      const counters = directCounterevidence(
        envelopes,
        baseEvidenceIds,
        createdAt,
      );
      const sourceEvidenceIds = new Set([
        ...baseEvidenceIds,
        ...counters.map((counter) => counter.event.eventId),
      ]);
      const relatedOpportunities = opportunities.filter(
        (opportunity) => keyIds.has(opportunity.correctionKeyId),
      );
      const applicableOpportunities = relatedOpportunities.filter(
        (opportunity) => opportunity.applicable,
      );
      const appliedOpportunities = applicableOpportunities.filter(
        (opportunity) =>
          opportunity.knowledgeAppliedBeforeCorrection,
      );
      const harmfulOpportunities = appliedOpportunities.filter(
        (opportunity) =>
          opportunity.correctionRepeated &&
          opportunity.outcomeKnown,
      );
      const helpfulOpportunities = appliedOpportunities.filter(
        (opportunity) =>
          !opportunity.correctionRepeated &&
          opportunity.outcomeKnown,
      );
      const verificationTimestamps =
        verificationEvidenceIds.flatMap((eventId) => {
          const event = eventsById.get(eventId);
          return event === undefined
            ? []
            : [event.event.timestamp];
        });
      const counterevidenceTimestamps = [
        ...counters.map((counter) => counter.event.timestamp),
        ...harmfulOpportunities.flatMap((opportunity) => {
          const episode = episodesById.get(opportunity.episodeId);
          const timestamp =
            episode?.outcomeQualifiedAt ??
            episode?.finishedAt;
          return timestamp === undefined ? [] : [timestamp];
        }),
      ];
      const validatedAt = latestTimestamp([
        ...verificationTimestamps,
        ...counterevidenceTimestamps,
      ]);
      const marks = evidenceMarks(
        correctionEventIds,
        verificationEvidenceIds,
      );
      const tier = tierFromMarks(marks);
      const firstKey = version.correctionKeys[0];
      if (firstKey === undefined) {
        throw new Error(
          `Knowledge version ${version.candidateId} has no key.`,
        );
      }
      let candidate = knowledgeCandidateSchema.parse({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        appliesWhen: appliesWhen(firstKey),
        conflictsWith: versions
          .filter(
            (other) =>
              other.topicKey === version.topicKey &&
              other.candidateId !== version.candidateId,
          )
          .map((other) => other.candidateId)
          .sort(),
        content: version.expectedBehavior,
        coverage: {
          applicableOpportunities: applicableOpportunities.length,
          observedOutcomes: applicableOpportunities.filter(
            (opportunity) => opportunity.outcomeKnown,
          ).length,
        },
        createdAt,
        evidenceMarks: marks,
        evidenceTier:
          counters.length > 0 ||
          harmfulOpportunities.length > 0
            ? "disputed"
            : tier,
        importance: 1,
        kind: "procedural",
        knowledgeId: version.candidateId,
        nonApplicability: [],
        scope: firstKey.scope,
        ...(firstKey.scopeId === undefined
          ? {}
          : {
              scopeId: firstKey.scopeId,
            }),
        sourceEpisodeIds: sourceEpisodes(
          sourceEvidenceIds,
          workEpisodes,
        ),
        sourceEvidenceIds: sortedUnique(sourceEvidenceIds),
        state:
          counters.length > 0 ||
          harmfulOpportunities.length > 0
            ? "disputed"
            : tier === "inferred"
              ? "candidate"
              : "active",
        topicKey: version.topicKey,
        utility: {
          applied: appliedOpportunities.length,
          harmful: harmfulOpportunities.length,
          helpful: helpfulOpportunities.length,
        },
        ...(validatedAt === undefined
          ? {}
          : {
              validatedAt,
            }),
      });
      for (const feedback of feedbackEvents) {
        if (
          feedback.targetType === "knowledge" &&
          feedback.targetId === candidate.knowledgeId
        ) {
          candidate = applyFeedback(candidate, feedback);
        }
      }
      return candidate;
    });
    return {
      candidates: reconcileTopicVersions(candidates),
    };
  }
}
