import {
  CURRENT_SCHEMA_VERSION,
  feedbackEventSchema,
  knowledgeCandidateSchema,
  type FeedbackEvent,
  type KnowledgeCandidate,
  type Scope,
} from "@provenloop/contracts";
import {
  containsPotentialSecret,
  sha256,
} from "@provenloop/domain";

export interface KnowledgeControlStore {
  knowledgeCandidates(
    ids?: readonly string[],
  ): readonly KnowledgeCandidate[];
  recordKnowledgeFeedback(input: {
    readonly event: FeedbackEvent;
    readonly updateCandidate?: (
      candidate: KnowledgeCandidate,
    ) => KnowledgeCandidate;
  }): {
    readonly candidate: KnowledgeCandidate;
    readonly recorded: boolean;
  };
  upsertKnowledgeCandidates(
    candidates: readonly KnowledgeCandidate[],
  ): number;
}

export interface KnowledgeControlProjection {
  acquireLease(): Promise<{
    release(): Promise<void>;
  }>;
  rebuild(): Promise<void>;
}

export interface RememberKnowledgeInput {
  readonly appliesWhen: readonly string[];
  readonly content: string;
  readonly kind?: KnowledgeCandidate["kind"];
  readonly nonApplicability?: readonly string[];
  readonly scope: Scope;
  readonly scopeId?: string;
}

export interface KnowledgeControlResult {
  readonly candidate?: KnowledgeCandidate;
  readonly changed: boolean;
  readonly feedbackId?: string;
}

export interface KnowledgeControlServiceOptions {
  readonly now?: () => Date;
  readonly projection: KnowledgeControlProjection;
  readonly store: KnowledgeControlStore;
}

const normalizedStrings = (
  values: readonly string[],
): readonly string[] =>
  [...new Set(
    values
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  )];

const validateScope = (
  scope: Scope,
  scopeId: string | undefined,
): string | undefined => {
  const normalizedScopeId = scopeId?.trim();
  if (scope === "personal") {
    if (normalizedScopeId !== undefined) {
      throw new Error(
        "Personal Knowledge cannot have a scope ID.",
      );
    }
    return undefined;
  }
  if (normalizedScopeId === undefined || normalizedScopeId.length === 0) {
    throw new Error(
      `${scope} Knowledge requires a scope ID.`,
    );
  }
  return normalizedScopeId;
};

export class KnowledgeControlService {
  readonly #now: () => Date;
  readonly #projection: KnowledgeControlProjection;
  readonly #store: KnowledgeControlStore;

  public constructor(options: KnowledgeControlServiceOptions) {
    this.#now = options.now ?? (() => new Date());
    this.#projection = options.projection;
    this.#store = options.store;
  }

  public async remember(
    input: RememberKnowledgeInput,
  ): Promise<KnowledgeControlResult> {
    const content = input.content.trim();
    const appliesWhen = normalizedStrings(input.appliesWhen);
    const nonApplicability = normalizedStrings(
      input.nonApplicability ?? [],
    );
    if (content.length === 0 || appliesWhen.length === 0) {
      throw new Error(
        "Remember requires non-empty content and applicability.",
      );
    }
    const scopeId = validateScope(input.scope, input.scopeId);
    if (
      [
        content,
        ...appliesWhen,
        ...nonApplicability,
        ...(scopeId === undefined ? [] : [scopeId]),
      ].some(containsPotentialSecret)
    ) {
      throw new Error(
        "Remember rejected content that may contain a secret.",
      );
    }
    const now = this.#now().toISOString();
    const identity = {
      appliesWhen,
      content,
      kind: input.kind ?? "procedural",
      nonApplicability,
      scope: input.scope,
      scopeId,
    };
    const candidate = knowledgeCandidateSchema.parse({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      appliesWhen,
      conflictsWith: [],
      content,
      coverage: {
        applicableOpportunities: 0,
        observedOutcomes: 0,
      },
      createdAt: now,
      evidenceMarks: [
        "user_confirmed",
      ],
      evidenceTier: "user_confirmed",
      importance: 1,
      kind: identity.kind,
      knowledgeId:
        `manual-knowledge-${sha256(identity).slice(0, 24)}`,
      nonApplicability,
      scope: input.scope,
      ...(scopeId === undefined ? {} : { scopeId }),
      sourceEpisodeIds: [],
      sourceEvidenceIds: [],
      state: "active",
      topicKey:
        `manual:${sha256({
          content,
          scope: input.scope,
          scopeId,
        }).slice(0, 24)}`,
      utility: {
        applied: 0,
        harmful: 0,
        helpful: 0,
      },
      validatedAt: now,
    });
    const lease = await this.#projection.acquireLease();
    try {
      const existing = this.#store.knowledgeCandidates([
        candidate.knowledgeId,
      ])[0];
      if (existing === undefined) {
        this.#store.upsertKnowledgeCandidates([
          candidate,
        ]);
      }
      await this.#projection.rebuild();
      return {
        candidate: existing ?? candidate,
        changed: existing === undefined,
      };
    } finally {
      await lease.release();
    }
  }

  public async correct(input: {
    readonly knowledgeId: string;
    readonly reason?: string;
  }): Promise<KnowledgeControlResult> {
    const knowledgeId = input.knowledgeId.trim();
    if (knowledgeId.length === 0) {
      throw new Error(
        "Correct requires a Knowledge ID.",
      );
    }
    const reason = input.reason?.trim();
    if (
      reason !== undefined &&
      containsPotentialSecret(reason)
    ) {
      throw new Error(
        "Correct rejected a reason that may contain a secret.",
      );
    }
    const lease = await this.#projection.acquireLease();
    try {
      const current = this.#store.knowledgeCandidates([
        knowledgeId,
      ])[0];
      if (current === undefined) {
        throw new Error(
          `Knowledge ${knowledgeId} does not exist.`,
        );
      }
      if (
        current.state === "disputed" &&
        current.evidenceTier === "disputed"
      ) {
        await this.#projection.rebuild();
        return {
          candidate: current,
          changed: false,
        };
      }
      const timestamp = this.#now().toISOString();
      const feedbackId =
        `feedback-${sha256({
          action: "correct",
          knowledgeId,
          preimage: sha256(current),
          reason,
        }).slice(0, 24)}`;
      const event = feedbackEventSchema.parse({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        evidenceRef: `control:${feedbackId}`,
        feedbackId,
        kind: "correct",
        ...(reason === undefined || reason.length === 0
          ? {}
          : {
              reason,
            }),
        source: "user",
        targetId: knowledgeId,
        targetType: "knowledge",
        timestamp,
      });
      const result = this.#store.recordKnowledgeFeedback({
        event,
        updateCandidate: (candidate) =>
          knowledgeCandidateSchema.parse({
            ...candidate,
            evidenceTier: "disputed",
            state: "disputed",
            validatedAt: timestamp,
          }),
      });
      await this.#projection.rebuild();
      return {
        candidate: result.candidate,
        changed: result.recorded,
        feedbackId,
      };
    } finally {
      await lease.release();
    }
  }

  public async mute(input: {
    readonly knowledgeId: string;
    readonly sessionId: string;
  }): Promise<KnowledgeControlResult> {
    const knowledgeId = input.knowledgeId.trim();
    const sessionId = input.sessionId.trim();
    if (knowledgeId.length === 0 || sessionId.length === 0) {
      throw new Error(
        "Mute requires Knowledge and Session IDs.",
      );
    }
    const event = feedbackEventSchema.parse({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      evidenceRef: sessionId,
      feedbackId:
        `feedback-${sha256({
          action: "mute_session",
          knowledgeId,
          sessionId,
        }).slice(0, 24)}`,
      kind: "mute_session",
      source: "user",
      targetId: knowledgeId,
      targetType: "knowledge",
      timestamp: this.#now().toISOString(),
    });
    const lease = await this.#projection.acquireLease();
    try {
      const result = this.#store.recordKnowledgeFeedback({
        event,
      });
      return {
        candidate: result.candidate,
        changed: result.recorded,
        feedbackId: event.feedbackId,
      };
    } finally {
      await lease.release();
    }
  }
}
