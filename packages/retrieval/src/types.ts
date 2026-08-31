import type {
  EvidenceTier,
  KnowledgeCandidate,
  Scope,
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
  index(records: readonly KnowledgeProjection[]): Promise<void>;
  rebuild(snapshot: KnowledgeProjectionSnapshot): Promise<void>;
  remove(ids: readonly string[]): Promise<void>;
  search(query: KnowledgeQuery): Promise<readonly KnowledgeRecord[]>;
}

export interface CanonicalKnowledgeStore {
  knowledgeCandidates(
    ids?: readonly string[],
  ): readonly KnowledgeCandidate[];
  knowledgeCandidatesWithUnavailableSources(
    candidates: readonly KnowledgeCandidate[],
  ): ReadonlySet<string>;
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

export const AUTOMATIC_RETRIEVAL_EVIDENCE_TIERS =
  new Set<EvidenceTier>([
    "externally_verified",
    "locked_preference",
    "repeated_evidence",
    "user_confirmed",
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
        scopeId === query.branchScopeId;
  }
};
