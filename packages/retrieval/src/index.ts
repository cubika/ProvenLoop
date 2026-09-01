export {
  KnowledgeProjectionManager,
  knowledgeProjectionFromCandidate,
} from "./projection.js";
export {
  CanonicalKnowledgeRetriever,
} from "./retriever.js";
export {
  ContextRetrievalService,
  DEFAULT_CONTEXT_TIMEOUT_MS,
  MAX_CONTEXT_TOKENS,
  estimateRenderedTokens,
  type ContextRetrievalServiceOptions,
} from "./context-service.js";
export {
  SqliteFtsKnowledgeBackend,
  type SqliteFtsKnowledgeBackendOptions,
} from "./sqlite-fts-knowledge-backend.js";
export {
  AUTOMATIC_RETRIEVAL_EVIDENCE_TIERS,
  branchScopeIdFor,
  scopeMatches,
  type CanonicalKnowledgeAdmissionStore,
  type CanonicalKnowledgeStore,
  type CanonicalContextStore,
  type ContextExplanation,
  type ContextFeedbackAction,
  type ContextFeedbackRequest,
  type ContextFeedbackResponse,
  type ContextItem,
  type ContextItemKind,
  type ContextRequest,
  type ContextResponse,
  type KnowledgeBackend,
  type KnowledgeBackendHealth,
  type KnowledgeAdmissionEvidence,
  type KnowledgeProjection,
  type KnowledgeProjectionSnapshot,
  type KnowledgeQuery,
  type KnowledgeRecord,
  type KnowledgeRetrievalQuery,
  type RetrievedKnowledge,
} from "./types.js";
