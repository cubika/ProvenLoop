import {
  captureEnvelopeSchema,
  contextUseRecordSchema,
  correctionKeySchema,
  feedbackEventSchema,
  knowledgeCandidateSchema,
  workEpisodeSchema,
  type CaptureEnvelope,
  type ContextUseRecord,
  type CorrectionKey,
  type FeedbackEvent,
  type KnowledgeCandidate,
  type WorkEpisode,
} from "@provenloop/contracts";

export type KnowledgeAdmissionReason =
  | "content_mismatch"
  | "incomplete_proof_chain"
  | "invalid_correction_source"
  | "invalid_verification_evidence"
  | "missing_applicability"
  | "missing_correction_key"
  | "missing_verification_evidence"
  | "recalled_knowledge_evidence"
  | "scope_mismatch"
  | "unpaired_verification_evidence"
  | "unverified_correction_occurrence"
  | "untrusted_verification_evidence";

export interface KnowledgeAdmissionInput {
  readonly candidate: KnowledgeCandidate;
  readonly contextUseRecords?: readonly ContextUseRecord[];
  readonly correctionKeys: readonly CorrectionKey[];
  readonly correctionSourceEventIds: ReadonlySet<string>;
  readonly envelopes: readonly CaptureEnvelope[];
  readonly feedbackEvents?: readonly FeedbackEvent[];
  readonly workEpisodes: readonly WorkEpisode[];
}

export interface KnowledgeAdmissionBatchInput {
  readonly candidates: readonly KnowledgeCandidate[];
  readonly contextUseRecords?: readonly ContextUseRecord[];
  readonly correctionKeys: readonly CorrectionKey[];
  readonly correctionSourceEventIds: ReadonlySet<string>;
  readonly envelopes: readonly CaptureEnvelope[];
  readonly feedbackEvents?: readonly FeedbackEvent[];
  readonly workEpisodes: readonly WorkEpisode[];
}

export interface KnowledgeAdmissionDecision {
  readonly admitted: boolean;
  readonly applicability: {
    readonly appliesWhen: readonly string[];
    readonly nonApplicability: readonly string[];
    readonly scope: KnowledgeCandidate["scope"];
    readonly scopeId?: string;
  };
  readonly conflictsWith: readonly string[];
  readonly knowledgeId: string;
  readonly proofChain: {
    readonly correctionKeyIds: readonly string[];
    readonly sourceEpisodeIds: readonly string[];
    readonly sourceEvidenceIds: readonly string[];
  };
  readonly reasons: readonly KnowledgeAdmissionReason[];
  readonly supersedes?: string;
}

const normalize = (value: string): string =>
  value.normalize("NFKC").replaceAll(/\s+/gu, " ").trim()
    .toLocaleLowerCase("en-US");

const sortedUnique = <T extends string>(values: Iterable<T>): T[] =>
  [...new Set(values)].sort();

const sameScope = (
  left: {
    readonly scope: KnowledgeCandidate["scope"];
    readonly scopeId: string | undefined;
  },
  right: {
    readonly scope: KnowledgeCandidate["scope"];
    readonly scopeId: string | undefined;
  },
): boolean =>
  left.scope === right.scope && left.scopeId === right.scopeId;

const validScope = (
  scope: {
    readonly scope: KnowledgeCandidate["scope"];
    readonly scopeId: string | undefined;
  },
): boolean =>
  scope.scope === "personal"
    ? scope.scopeId === undefined
    : scope.scopeId !== undefined;

const validVerificationEvent = (
  envelope: CaptureEnvelope,
): boolean => {
  const event = envelope.event;
  if (
    event.eventType !== "test.completed" &&
    event.eventType !== "build.completed" &&
    event.eventType !== "verification.completed"
  ) {
    return false;
  }
  if (
    event.completionStatus !== undefined &&
    event.completionStatus !== "succeeded"
  ) {
    return false;
  }
  if (event.exitCode !== undefined && event.exitCode !== 0) {
    return false;
  }
  return (
    event.completionStatus === "succeeded" ||
    event.exitCode === 0
  );
};

const recalledReferences = (
  records: readonly ContextUseRecord[],
): ReadonlySet<string> => {
  const references = new Set<string>();
  for (const record of records) {
    references.add(record.requestId);
    for (const reference of [
      ...record.appliedKnowledgeIds,
      ...record.candidateKnowledgeIds,
      ...record.returnedKnowledgeIds,
    ]) {
      references.add(reference);
      if (reference.startsWith("knowledge:")) {
        references.add(reference.slice("knowledge:".length));
      } else {
        references.add(`knowledge:${reference}`);
      }
    }
  }
  return references;
};

const recordRecallsKnowledge = (
  record: ContextUseRecord,
  knowledgeId: string,
): boolean => {
  const references = new Set([
    knowledgeId,
    `knowledge:${knowledgeId}`,
  ]);
  return [
    ...record.appliedKnowledgeIds,
    ...record.returnedKnowledgeIds,
  ].some((reference) => references.has(reference));
};

const scopeIdentity = (
  scope: {
    readonly scope: KnowledgeCandidate["scope"];
    readonly scopeId: string | undefined;
  },
): string => JSON.stringify([
  scope.scope,
  scope.scopeId,
]);

const decision = (
  candidate: KnowledgeCandidate,
  correctionKeyIds: readonly string[],
  reasons: ReadonlySet<KnowledgeAdmissionReason>,
): KnowledgeAdmissionDecision => ({
  admitted: reasons.size === 0,
  applicability: {
    appliesWhen: [...candidate.appliesWhen],
    nonApplicability: [...candidate.nonApplicability],
    scope: candidate.scope,
    ...(candidate.scopeId === undefined
      ? {}
      : {
          scopeId: candidate.scopeId,
        }),
  },
  conflictsWith: [...candidate.conflictsWith],
  knowledgeId: candidate.knowledgeId,
  proofChain: {
    correctionKeyIds: [...correctionKeyIds],
    sourceEpisodeIds: [...candidate.sourceEpisodeIds],
    sourceEvidenceIds: [...candidate.sourceEvidenceIds],
  },
  reasons: sortedUnique(reasons),
  ...(candidate.supersedes === undefined
    ? {}
    : {
        supersedes: candidate.supersedes,
      }),
});

export const refreshKnowledgeAdmissionDecision = (
  previous: KnowledgeAdmissionDecision,
  input: KnowledgeCandidate,
): KnowledgeAdmissionDecision => {
  const candidate = knowledgeCandidateSchema.parse(input);
  if (previous.knowledgeId !== candidate.knowledgeId) {
      throw new Error(
        "Knowledge admission decision and candidate IDs must match.",
      );
  }
  return decision(
      candidate,
      previous.proofChain.correctionKeyIds,
      new Set(previous.reasons),
  );
};

interface PreparedKnowledgeAdmissionContext {
  readonly correctionKeysBySourceEventId: ReadonlyMap<
    string,
    readonly CorrectionKey[]
  >;
  readonly contextUseRecordsByEpisode: ReadonlyMap<
    string,
    readonly ContextUseRecord[]
  >;
  readonly envelopesById: ReadonlyMap<string, CaptureEnvelope>;
  readonly explicitUserScopesByKnowledgeId: ReadonlyMap<
    string,
    readonly {
      readonly scopeIdentity: string;
      readonly timestamp: string;
    }[]
  >;
  readonly knownCorrectionSourceEventIds: ReadonlySet<string>;
  readonly recalledReferences: ReadonlySet<string>;
  readonly workEpisodesByEventId: ReadonlyMap<
    string,
    readonly WorkEpisode[]
  >;
}

const prepareContext = (
  input: Omit<KnowledgeAdmissionBatchInput, "candidates">,
): PreparedKnowledgeAdmissionContext => {
  const contextUseRecords = (input.contextUseRecords ?? []).map(
    (record) => contextUseRecordSchema.parse(record),
  );
  const contextUseRecordsByEpisode =
    new Map<string, ContextUseRecord[]>();
  for (const record of contextUseRecords) {
    if (record.episodeId === undefined) {
      continue;
    }
    const records =
      contextUseRecordsByEpisode.get(record.episodeId) ?? [];
    records.push(record);
    contextUseRecordsByEpisode.set(record.episodeId, records);
  }
  const correctionKeys = input.correctionKeys.map((key) =>
    correctionKeySchema.parse(key),
  );
  const correctionKeysBySourceEventId =
    new Map<string, CorrectionKey[]>();
  for (const key of correctionKeys) {
    for (const sourceEventId of key.sourceCorrectionEventIds) {
      const keys =
        correctionKeysBySourceEventId.get(sourceEventId) ?? [];
      keys.push(key);
      correctionKeysBySourceEventId.set(sourceEventId, keys);
    }
  }
  const envelopes = input.envelopes.map((envelope) =>
    captureEnvelopeSchema.parse(envelope),
  );
  const feedbackEvents = (input.feedbackEvents ?? []).map((feedback) =>
    feedbackEventSchema.parse(feedback),
  );
  const explicitUserScopesByKnowledgeId =
    new Map<
      string,
      {
        readonly scopeIdentity: string;
        readonly timestamp: string;
      }[]
    >();
  for (const feedback of feedbackEvents) {
    if (
      feedback.targetType !== "knowledge" ||
      feedback.kind !== "set_scope" ||
      feedback.source !== "user" ||
      feedback.scopeChange === undefined
    ) {
      continue;
    }
    const scopes =
      explicitUserScopesByKnowledgeId.get(feedback.targetId) ??
      [];
    scopes.push({
      scopeIdentity: scopeIdentity({
        scope: feedback.scopeChange.scope,
        scopeId: feedback.scopeChange.scopeId,
      }),
      timestamp: feedback.timestamp,
    });
    explicitUserScopesByKnowledgeId.set(feedback.targetId, scopes);
  }
  const workEpisodes = input.workEpisodes.map((episode) =>
    workEpisodeSchema.parse(episode),
  );
  const workEpisodesByEventId = new Map<string, WorkEpisode[]>();
  for (const episode of workEpisodes) {
    for (const eventId of episode.sourceEventIds) {
      const episodes = workEpisodesByEventId.get(eventId) ?? [];
      episodes.push(episode);
      workEpisodesByEventId.set(eventId, episodes);
    }
  }
  return {
    correctionKeysBySourceEventId,
    contextUseRecordsByEpisode,
    envelopesById: new Map(
      envelopes.map((envelope) => [
        envelope.event.eventId,
        envelope,
      ]),
    ),
    explicitUserScopesByKnowledgeId,
    knownCorrectionSourceEventIds: new Set([
      ...input.correctionSourceEventIds,
      ...correctionKeys.flatMap(
        (key) => key.sourceCorrectionEventIds,
      ),
    ]),
    recalledReferences: recalledReferences(contextUseRecords),
    workEpisodesByEventId,
  };
};

const evaluateCandidate = (
  input: KnowledgeCandidate,
  context: PreparedKnowledgeAdmissionContext,
): KnowledgeAdmissionDecision => {
  const candidate = knowledgeCandidateSchema.parse(input);
  const reasons = new Set<KnowledgeAdmissionReason>();
  const sourceEvidence = new Set(candidate.sourceEvidenceIds);
  if (
      candidate.sourceEvidenceIds.some((evidenceId) =>
        context.recalledReferences.has(evidenceId),
      )
  ) {
      reasons.add("recalled_knowledge_evidence");
  }

  const correctionSourceIds = candidate.sourceEvidenceIds.filter(
      (eventId) =>
        context.knownCorrectionSourceEventIds.has(eventId),
  );
  const correctionDerived =
      correctionSourceIds.length > 0 ||
      candidate.topicKey.startsWith("correction:");
  if (!correctionDerived) {
      return decision(candidate, [], reasons);
  }

  const relatedKeysById = new Map<string, CorrectionKey>();
  for (const sourceEventId of sourceEvidence) {
      for (
        const key of
          context.correctionKeysBySourceEventId.get(sourceEventId) ?? []
      ) {
        relatedKeysById.set(key.correctionKeyId, key);
      }
  }
  const relatedKeys = [...relatedKeysById.values()].sort(
      (left, right) =>
        left.correctionKeyId.localeCompare(right.correctionKeyId),
  );
  const relatedKeyIds = relatedKeys
      .map((key) => key.correctionKeyId)
      .sort();
  if (relatedKeys.length === 0) {
      reasons.add("missing_correction_key");
      return decision(candidate, relatedKeyIds, reasons);
  }

  const expectedCorrectionIds = sortedUnique(
      relatedKeys.flatMap((key) => key.sourceCorrectionEventIds),
  );
  const verificationIds = sortedUnique(
      relatedKeys.flatMap((key) => key.verificationEvidenceIds),
  );
  const expectedProof = [
      ...expectedCorrectionIds,
      ...verificationIds,
  ];
  if (
      expectedProof.some((eventId) => !sourceEvidence.has(eventId))
  ) {
      reasons.add("incomplete_proof_chain");
  }
  if (
      relatedKeys.some(
        (key) => normalize(key.expectedBehavior) !== normalize(
          candidate.content,
        ),
      )
  ) {
      reasons.add("content_mismatch");
  }
  if (
      candidate.appliesWhen.length === 0 ||
      relatedKeys.some(
        (key) =>
          !candidate.appliesWhen.some(
            (condition) => normalize(condition) === normalize(key.trigger),
          ),
      )
  ) {
      reasons.add("missing_applicability");
  }

  const sourceScopes = relatedKeys.map((key) => ({
      scope: key.scope,
      scopeId: key.scopeId,
  }));
  const candidateScope = {
      scope: candidate.scope,
      scopeId: candidate.scopeId,
  };
  if (
      !validScope(candidateScope) ||
      sourceScopes.some((scope) => !validScope(scope)) ||
      sourceScopes.some(
        (scope) =>
          !sameScope(candidateScope, scope) &&
          !(
            context.explicitUserScopesByKnowledgeId
              .get(candidate.knowledgeId)
              ?.some(
                (scope) =>
                  scope.scopeIdentity === scopeIdentity(candidateScope) &&
                  Date.parse(scope.timestamp) >=
                    Date.parse(candidate.createdAt),
              ) ?? false
          ),
      )
  ) {
      reasons.add("scope_mismatch");
  }

  for (const eventId of expectedCorrectionIds) {
      const envelope = context.envelopesById.get(eventId);
      if (
        envelope === undefined ||
        envelope.event.eventType !== "user.corrected" ||
        envelope.event.trust !== "user"
      ) {
        reasons.add("invalid_correction_source");
      }
      const correctionVerificationIds = sortedUnique(
        relatedKeys
          .filter((key) =>
            key.sourceCorrectionEventIds.includes(eventId),
          )
          .flatMap((key) => key.verificationEvidenceIds),
      );
      const pairedEpisode = (
        context.workEpisodesByEventId.get(eventId) ?? []
      ).find((episode) =>
        correctionVerificationIds.some((verificationId) => {
          if (!episode.sourceEventIds.includes(verificationId)) {
            return false;
          }
          const verification =
            context.envelopesById.get(verificationId);
          return (
            verification !== undefined &&
            (
              verification.event.trust === "system" ||
              verification.event.trust === "tool"
            ) &&
            validVerificationEvent(verification) &&
            envelope !== undefined &&
            Date.parse(envelope.event.timestamp) <
              Date.parse(verification.event.timestamp)
          );
        }),
      );
      if (pairedEpisode === undefined) {
        reasons.add("unverified_correction_occurrence");
      } else if (
        !candidate.sourceEpisodeIds.includes(pairedEpisode.episodeId)
      ) {
        reasons.add("incomplete_proof_chain");
      }
  }

  if (verificationIds.length === 0) {
      reasons.add("missing_verification_evidence");
      return decision(candidate, relatedKeyIds, reasons);
  }

  for (const verificationId of verificationIds) {
      const verification = context.envelopesById.get(verificationId);
      if (verification === undefined) {
        reasons.add("invalid_verification_evidence");
        continue;
      }
      if (
        verification.event.trust !== "system" &&
        verification.event.trust !== "tool"
      ) {
        reasons.add("untrusted_verification_evidence");
      }
      if (!validVerificationEvent(verification)) {
        reasons.add("invalid_verification_evidence");
      }
      if (
        context.recalledReferences.has(verificationId) ||
        (
          verification.event.parentEventId !== undefined &&
          context.recalledReferences.has(
            verification.event.parentEventId,
          )
        )
      ) {
        reasons.add("recalled_knowledge_evidence");
      }
      const verificationCorrectionIds = relatedKeys
        .filter((key) =>
          key.verificationEvidenceIds.includes(verificationId),
        )
        .flatMap((key) => key.sourceCorrectionEventIds);
      const pairedEpisode = (
        context.workEpisodesByEventId.get(verificationId) ?? []
      ).find(
        (episode) =>
          episode.sourceEventIds.includes(verificationId) &&
          verificationCorrectionIds.some((correctionId) => {
            if (!episode.sourceEventIds.includes(correctionId)) {
              return false;
            }
            const correction =
              context.envelopesById.get(correctionId);
            return (
              correction !== undefined &&
              Date.parse(correction.event.timestamp) <
                Date.parse(verification.event.timestamp)
            );
          }),
      );
      if (pairedEpisode === undefined) {
        reasons.add("unpaired_verification_evidence");
      } else {
        if (!candidate.sourceEpisodeIds.includes(pairedEpisode.episodeId)) {
          reasons.add("incomplete_proof_chain");
        }
        const pairedCorrectionIds = verificationCorrectionIds.filter(
          (correctionId) =>
            pairedEpisode.sourceEventIds.includes(correctionId),
        );
        const correctionTimestamps = pairedCorrectionIds
          .flatMap((correctionId) => {
            const source =
              context.envelopesById.get(correctionId);
            return source === undefined
              ? []
              : [
                  Date.parse(source.event.timestamp),
                ];
          });
        const firstCorrectionAt = Math.min(...correctionTimestamps);
        const verificationAt = Date.parse(verification.event.timestamp);
        if (
          Number.isFinite(firstCorrectionAt) &&
          (
            context.contextUseRecordsByEpisode.get(
              pairedEpisode.episodeId,
            ) ?? []
          ).some(
            (record) =>
              record.episodeId === pairedEpisode.episodeId &&
              Date.parse(record.createdAt) >= firstCorrectionAt &&
              Date.parse(record.createdAt) <= verificationAt &&
              recordRecallsKnowledge(record, candidate.knowledgeId),
          )
        ) {
          reasons.add("recalled_knowledge_evidence");
        }
      }
  }

  return decision(candidate, relatedKeyIds, reasons);
};

export class KnowledgeAdmissionPolicy {
  public evaluate(
      input: KnowledgeAdmissionInput,
  ): KnowledgeAdmissionDecision {
      const [result] = this.evaluateAll({
        candidates: [
          input.candidate,
        ],
        ...(input.contextUseRecords === undefined
          ? {}
          : {
              contextUseRecords: input.contextUseRecords,
            }),
        correctionKeys: input.correctionKeys,
        correctionSourceEventIds: input.correctionSourceEventIds,
        envelopes: input.envelopes,
        ...(input.feedbackEvents === undefined
          ? {}
          : {
              feedbackEvents: input.feedbackEvents,
            }),
        workEpisodes: input.workEpisodes,
      });
      if (result === undefined) {
        throw new Error("Knowledge admission produced no decision.");
      }
      return result;
  }

  public evaluateAll(
      input: KnowledgeAdmissionBatchInput,
  ): readonly KnowledgeAdmissionDecision[] {
      const {
        candidates,
        ...contextInput
      } = input;
      const context = prepareContext(contextInput);
      return candidates.map((candidate) =>
        evaluateCandidate(candidate, context),
      );
  }
}
