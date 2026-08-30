import type {
  CaptureEnvelope,
  EpisodeAssociation,
  EpisodeGroupingCorrection,
  WorkEpisode,
} from "@provenloop/contracts";
import {
  WorkEpisodeBuilder,
  type WorkEpisodeBuildResult,
} from "@provenloop/domain";

export interface WorkEpisodeProjectionStore {
  episodeSourceEnvelopes(): readonly CaptureEnvelope[];
  episodeGroupingCorrections(): readonly EpisodeGroupingCorrection[];
  replaceWorkEpisodeProjection(input: {
    readonly associations: readonly EpisodeAssociation[];
    readonly corrections: readonly EpisodeGroupingCorrection[];
    readonly episodes: readonly WorkEpisode[];
  }): {
    readonly associations: number;
    readonly corrections: number;
    readonly episodes: number;
  };
}

export interface WorkEpisodeProjectorOptions {
  readonly builder?: WorkEpisodeBuilder;
  readonly store: WorkEpisodeProjectionStore;
}

export interface WorkEpisodeProjectionResult
extends WorkEpisodeBuildResult {
  readonly persistedAssociations: number;
  readonly persistedCorrections: number;
  readonly persistedEpisodes: number;
}

export class WorkEpisodeProjector {
  readonly #builder: WorkEpisodeBuilder;
  readonly #store: WorkEpisodeProjectionStore;

  public constructor(options: WorkEpisodeProjectorOptions) {
    this.#builder = options.builder ?? new WorkEpisodeBuilder();
    this.#store = options.store;
  }

  public rebuild(
    corrections?: readonly EpisodeGroupingCorrection[],
  ): WorkEpisodeProjectionResult {
    const storedCorrections =
      this.#store.episodeGroupingCorrections();
    const effectiveCorrections =
      corrections === undefined
        ? storedCorrections
        : [
            ...new Map(
              [
                ...storedCorrections,
                ...corrections,
              ].map((correction) => [
                correction.correctionId,
                correction,
              ]),
            ).values(),
          ].sort(
            (left, right) =>
              Date.parse(left.timestamp) -
                Date.parse(right.timestamp) ||
              left.correctionId.localeCompare(right.correctionId),
          );
    const result = this.#builder.build(
      this.#store.episodeSourceEnvelopes(),
      effectiveCorrections,
    );
    const persisted = this.#store.replaceWorkEpisodeProjection({
      associations: result.associations,
      corrections: effectiveCorrections,
      episodes: result.episodes,
    });
    return {
      ...result,
      persistedAssociations: persisted.associations,
      persistedCorrections: persisted.corrections,
      persistedEpisodes: persisted.episodes,
    };
  }
}
