export {
  KnowledgeProjectionManager,
  knowledgeProjectionFromCandidate,
} from "./projection.js";
export {
  CanonicalKnowledgeRetriever,
} from "./retriever.js";
export {
  SqliteFtsKnowledgeBackend,
} from "./sqlite-fts-knowledge-backend.js";
export {
  AUTOMATIC_RETRIEVAL_EVIDENCE_TIERS,
  scopeMatches,
  type CanonicalKnowledgeStore,
  type KnowledgeBackend,
  type KnowledgeBackendHealth,
  type KnowledgeProjection,
  type KnowledgeProjectionSnapshot,
  type KnowledgeQuery,
  type KnowledgeRecord,
  type KnowledgeRetrievalQuery,
  type RetrievedKnowledge,
} from "./types.js";
