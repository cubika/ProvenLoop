import type {
  BranchContext,
  CaptureEnvelope,
  ContextUseRecord,
  EvidenceTier,
  FeedbackEvent,
  KnowledgeCandidate,
  Scope,
  WorkEpisode,
} from "@provenloop/contracts";

export interface KnowledgeProjection {
  readonly appliesWhen: readonly string[];
  readonly content: string;
  readonly knowledgeId: string;
  readonly nonApplicability: readonly string[];
  readonly projectionVersion: 1;
  readonly sourceDigest: string;
  readonly topicKey: string;
}

export interface KnowledgeRecord extends KnowledgeProjection {
  readonly score: number;
}

export interface KnowledgeQuery {
  readonly limit: number;
  readonly offset?: number;
  readonly text: string;
}

export interface KnowledgeProjectionSnapshot {
  readonly records: readonly KnowledgeProjection[];
}

export interface KnowledgeBackendHealth {
  readonly fts5Available: boolean;
  readonly quickCheck: string;
  readonly recordCount: number;
  readonly status: "healthy" | "unhealthy";
}

export interface KnowledgeBackend {
  get(id: string): Promise<KnowledgeRecord | undefined>;
  health(): Promise<KnowledgeBackendHealth>;
  healthWithTimeout?(
    timeoutMs: number,
  ): Promise<KnowledgeBackendHealth>;
  index(records: readonly KnowledgeProjection[]): Promise<void>;
  rebuild(snapshot: KnowledgeProjectionSnapshot): Promise<void>;
  remove(ids: readonly string[]): Promise<void>;
  search(query: KnowledgeQuery): Promise<readonly KnowledgeRecord[]>;
  searchWithTimeout?(
    query: KnowledgeQuery,
    timeoutMs: number,
  ): Promise<readonly KnowledgeRecord[]>;
}

export interface CanonicalKnowledgeStore {
  knowledgeCandidates(
    ids?: readonly string[],
  ): readonly KnowledgeCandidate[];
  knowledgeCandidatesWithUnavailableSources(
    candidates: readonly KnowledgeCandidate[],
  ): ReadonlySet<string>;
}

export interface CanonicalContextStore
extends CanonicalKnowledgeStore {
  appendContextUseRecord(record: ContextUseRecord): boolean;
  branchContextFor(input: {
    readonly branch: string;
    readonly headSha: string;
    readonly now?: Date;
    readonly repoId: string;
  }): BranchContext | undefined;
  branchContexts(): readonly BranchContext[];
  contextUseRecords(
    sessionId?: string,
  ): readonly ContextUseRecord[];
  episodeSourceEnvelopes(): readonly CaptureEnvelope[];
  feedbackEvents(targetId?: string): readonly FeedbackEvent[];
  recordKnowledgeFeedback(input: {
    readonly contextRequestId?: string;
    readonly event: FeedbackEvent;
    readonly updateCandidate?: (
      candidate: KnowledgeCandidate,
    ) => KnowledgeCandidate;
    readonly updateContextUseRecord?: (
      record: ContextUseRecord,
    ) => ContextUseRecord;
  }): {
    readonly candidate: KnowledgeCandidate;
    readonly recorded: boolean;
  };
  sessionMuted(sessionId: string): boolean;
  workEpisodes(): readonly WorkEpisode[];
}

export interface KnowledgeRetrievalQuery {
  readonly branchScopeId?: string;
  readonly limit: number;
  readonly now?: Date;
  readonly repositoryScopeId?: string;
  readonly text: string;
  readonly workflowScopeId?: string;
}

export interface RetrievedKnowledge {
  readonly candidate: KnowledgeCandidate;
  readonly score: number;
}

export interface ContextRequest {
  readonly branch?: string;
  readonly cwd: string;
  readonly fileHints?: readonly string[];
  readonly headSha?: string;
  readonly now?: Date;
  readonly prompt: string;
  readonly repoId?: string;
  readonly sessionId: string;
  readonly tokenBudget: number;
  readonly workflowScopeId?: string;
}

export type ContextItemKind = "branch_context" | "knowledge";

export interface ContextItem {
  readonly applicabilitySummary: string;
  readonly evidenceTier?: EvidenceTier;
  readonly explanationRef: string;
  readonly guidance: string;
  readonly id: string;
  readonly kind: ContextItemKind;
  readonly rank: number;
  readonly scope: Scope;
  readonly scopeId?: string;
}

export interface ContextResponse {
  readonly items: readonly ContextItem[];
  readonly latencyMs: number;
  readonly renderedTokens: number;
  readonly requestId: string;
  readonly status:
    | "degraded"
    | "muted"
    | "ok";
  readonly statusDetail?: string;
}

export interface ExplainRequest {
  readonly explanationRef: string;
  readonly sessionId: string;
}

export interface ContextExplanation {
  readonly applicability?: Readonly<Record<string, unknown>>;
  readonly contradictoryEvidence?: readonly Readonly<
    Record<string, unknown>
  >[];
  readonly currentState?: string;
  readonly evidenceTier?: EvidenceTier;
  readonly explanationRef: string;
  readonly id?: string;
  readonly kind?: ContextItemKind;
  readonly provenance?: Readonly<Record<string, unknown>>;
  readonly status:
    | "available"
    | "not_found"
    | "not_previously_retrieved";
}

export type ContextFeedbackAction =
  | "confirm"
  | "helpful"
  | "irrelevant"
  | "mute_session"
  | "revoke"
  | "set_scope"
  | "stale"
  | "wrong";

export interface ContextFeedbackRequest {
  readonly action: ContextFeedbackAction;
  readonly branchScopeId?: string;
  readonly reason?: string;
  readonly repositoryScopeId?: string;
  readonly requestId: string;
  readonly scope?: Scope;
  readonly sessionId: string;
  readonly targetId: string;
  readonly workflowScopeId?: string;
}

export interface ContextFeedbackResponse {
  readonly candidate?: KnowledgeCandidate;
  readonly feedbackId?: string;
  readonly projectionStatus?: "degraded" | "synchronized";
  readonly recordedKind?: FeedbackEvent["kind"];
  readonly status:
    | "already_recorded"
    | "not_found"
    | "not_previously_retrieved"
    | "recorded";
  readonly statusDetail?: string;
}

export const AUTOMATIC_RETRIEVAL_EVIDENCE_TIERS =
  new Set<EvidenceTier>([
    "externally_verified",
    "locked_preference",
    "repeated_evidence",
    "user_confirmed",
  ]);

export const branchScopeIdFor = (
  repositoryScopeId: string,
  branchScopeId: string,
): string => JSON.stringify([
  repositoryScopeId,
  branchScopeId,
]);

export const scopeMatches = (
  scope: Scope,
  scopeId: string | undefined,
  query: KnowledgeRetrievalQuery,
): boolean => {
  switch (scope) {
    case "personal":
      return true;
    case "workflow":
      return scopeId !== undefined &&
        scopeId === query.workflowScopeId;
    case "repository":
      return scopeId !== undefined &&
        scopeId === query.repositoryScopeId;
    case "branch":
      return scopeId !== undefined &&
        query.repositoryScopeId !== undefined &&
        query.branchScopeId !== undefined &&
        scopeId === branchScopeIdFor(
          query.repositoryScopeId,
          query.branchScopeId,
        );
  }
};
