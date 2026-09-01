import { describe, expect, it } from "vitest";

import {
  CURRENT_SCHEMA_VERSION,
  type CorrectionKey,
  type KnowledgeCandidate,
} from "@provenloop/contracts";
import {
  CanonicalKnowledgeRetriever,
  knowledgeProjectionFromCandidate,
  type KnowledgeBackend,
  type KnowledgeRecord,
} from "@provenloop/retrieval";

const candidate = (
  sourceEvidenceIds: readonly string[],
): KnowledgeCandidate => ({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  appliesWhen: [
    "package validation",
  ],
  conflictsWith: [],
  content: "Run the targeted Vitest command.",
  coverage: {
    applicableOpportunities: 1,
    observedOutcomes: 1,
  },
  createdAt: "2026-09-01T00:00:00.000Z",
  evidenceMarks: [
    "externally_verified",
  ],
  evidenceTier: "externally_verified",
  importance: 1,
  kind: "procedural",
  knowledgeId: "knowledge-package-validation",
  nonApplicability: [],
  scope: "repository",
  scopeId: "repo-1",
  sourceEpisodeIds: [
    "episode-1",
  ],
  sourceEvidenceIds: [
    ...sourceEvidenceIds,
  ],
  state: "active",
  topicKey: "testing:test-runner:package-validation",
  utility: {
    applied: 0,
    harmful: 0,
    helpful: 0,
  },
  validatedAt: "2026-09-01T00:00:00.000Z",
});

const correctionKey = (
  verificationEvidenceIds: readonly string[],
): CorrectionKey => ({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  correctionKeyId: "correction-package-validation",
  createdAt: "2026-09-01T00:00:00.000Z",
  expectedBehavior: "Run the targeted Vitest command.",
  scope: "repository",
  scopeId: "repo-1",
  sourceCorrectionEventIds: [
    "event-correction",
  ],
  subsystem: "test-runner",
  taskFamily: "testing",
  trigger: "package validation",
  verificationEvidenceIds: [
    ...verificationEvidenceIds,
  ],
  violatedConstraint:
    "Inspect package scripts before choosing a test runner.",
});

const backendFor = (
  knowledge: KnowledgeCandidate,
): KnowledgeBackend => {
  const projection = knowledgeProjectionFromCandidate(knowledge);
  const record: KnowledgeRecord = {
    ...projection,
    score: 1,
  };
  return {
    get: async () => record,
    health: async () => ({
      fts5Available: true,
      quickCheck: "ok",
      recordCount: 1,
      status: "healthy",
    }),
    index: async () => undefined,
    rebuild: async () => undefined,
    remove: async () => undefined,
    search: async () => [
      record,
    ],
  };
};

describe("CanonicalKnowledgeRetriever correction admission", () => {
  it("rejects correction-based Knowledge until its key is verified", async () => {
    const knowledge = candidate([
      "event-correction",
    ]);
    let keys: readonly CorrectionKey[] = [];
    const retriever = new CanonicalKnowledgeRetriever({
      backend: backendFor(knowledge),
      store: {
        correctionKeys: () => keys,
        correctionSourceEventIds: () => new Set([
          "event-correction",
        ]),
        knowledgeCandidates: () => [
          knowledge,
        ],
        knowledgeCandidatesWithUnavailableSources: () => new Set(),
      },
    });
    const query = {
      limit: 3,
      repositoryScopeId: "repo-1",
      text: "package validation",
    };

    await expect(retriever.search(query)).resolves.toEqual([]);

    keys = [
      correctionKey([]),
    ];
    await expect(retriever.search(query)).resolves.toEqual([]);

    keys = [
      correctionKey([
        "event-verification",
      ]),
    ];
    await expect(retriever.search(query)).resolves.toEqual([
      {
        candidate: knowledge,
        score: 1,
      },
    ]);
  });

  it("does not affect Knowledge without correction sources", async () => {
    const knowledge = candidate([
      "event-independent-evidence",
    ]);
    const retriever = new CanonicalKnowledgeRetriever({
      backend: backendFor(knowledge),
      store: {
        correctionKeys: () => [
          correctionKey([]),
        ],
        correctionSourceEventIds: () => new Set([
          "event-correction",
        ]),
        knowledgeCandidates: () => [
          knowledge,
        ],
        knowledgeCandidatesWithUnavailableSources: () => new Set(),
      },
    });

    await expect(
      retriever.search({
        limit: 3,
        repositoryScopeId: "repo-1",
        text: "package validation",
      }),
    ).resolves.toHaveLength(1);
  });
});
