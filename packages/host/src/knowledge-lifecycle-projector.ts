import type {
  CaptureEnvelope,
  CorrectionKey,
  CorrectionOpportunity,
  FeedbackEvent,
  KnowledgeCandidate,
  WorkEpisode,
} from "@provenloop/contracts";
import {
  KnowledgeLifecycleBuilder,
} from "@provenloop/domain";

export interface KnowledgeLifecycleProjectionStore {
  correctionKeys(): readonly CorrectionKey[];
  correctionOpportunities(): readonly CorrectionOpportunity[];
  episodeSourceEnvelopes(): readonly CaptureEnvelope[];
  feedbackEvents(): readonly FeedbackEvent[];
  hasActiveDeletion(): boolean;
  knowledgeDeletionBlocked(knowledgeId: string): boolean;
  replaceCorrectionKnowledgeCandidates(input: {
    readonly allowDuringDeletion?: boolean;
    readonly candidates: readonly KnowledgeCandidate[];
  }): number;
  workEpisodes(): readonly WorkEpisode[];
}

export interface KnowledgeLifecycleProjectorOptions {
  readonly builder?: KnowledgeLifecycleBuilder;
  readonly store: KnowledgeLifecycleProjectionStore;
}

export interface KnowledgeLifecycleProjectionResult {
  readonly candidates: readonly KnowledgeCandidate[];
  readonly persistedCandidates: number;
  readonly suppressedForgottenKnowledgeIds: readonly string[];
}

export interface KnowledgeLifecycleRebuildOptions {
  readonly allowDuringDeletion?: boolean;
}

export class KnowledgeLifecycleProjector {
  readonly #builder: KnowledgeLifecycleBuilder;
  readonly #store: KnowledgeLifecycleProjectionStore;

  public constructor(options: KnowledgeLifecycleProjectorOptions) {
    this.#builder = options.builder ?? new KnowledgeLifecycleBuilder();
    this.#store = options.store;
  }

  public rebuild(
    options: KnowledgeLifecycleRebuildOptions = {},
  ): KnowledgeLifecycleProjectionResult {
    if (
      this.#store.hasActiveDeletion() &&
      options.allowDuringDeletion !== true
    ) {
      throw new Error(
        "Knowledge lifecycle projection is blocked by an active deletion.",
      );
    }
    const built = this.#builder.build({
      correctionKeys: this.#store.correctionKeys(),
      correctionOpportunities:
        this.#store.correctionOpportunities(),
      envelopes: this.#store.episodeSourceEnvelopes(),
      feedbackEvents: this.#store.feedbackEvents(),
      workEpisodes: this.#store.workEpisodes(),
    });
    const suppressedForgottenKnowledgeIds = built.candidates
      .filter((candidate) =>
        this.#store.knowledgeDeletionBlocked(candidate.knowledgeId),
      )
      .map((candidate) => candidate.knowledgeId)
      .sort();
    const candidates = built.candidates.filter(
      (candidate) =>
        !suppressedForgottenKnowledgeIds.includes(
          candidate.knowledgeId,
        ),
    );
    return {
      candidates,
      persistedCandidates:
        this.#store.replaceCorrectionKnowledgeCandidates({
          ...(options.allowDuringDeletion === true
            ? {
                allowDuringDeletion: true,
              }
            : {}),
          candidates,
        }),
      suppressedForgottenKnowledgeIds,
    };
  }
}
