import {
  randomUUID,
} from "node:crypto";

import {
  CURRENT_SCHEMA_VERSION,
  type BranchContext,
  type ContextUseRecord,
  type FeedbackEvent,
  type KnowledgeCandidate,
  type Scope,
} from "@provenloop/contracts";
import {
  containsPotentialSecret,
  redactPotentialSecrets,
  sha256,
} from "@provenloop/domain";

import { CanonicalKnowledgeRetriever } from "./retriever.js";
import { branchScopeIdFor } from "./types.js";
import type {
  CanonicalContextStore,
  ContextExplanation,
  ContextFeedbackAction,
  ContextFeedbackRequest,
  ContextFeedbackResponse,
  ContextItem,
  ContextRequest,
  ContextResponse,
  KnowledgeBackend,
  RetrievedKnowledge,
} from "./types.js";

const MAX_CONTEXT_ITEMS = 3;
const SEARCH_RESULT_LIMIT = 20;
const SEARCH_TERM_LIMIT = 8;
export const DEFAULT_CONTEXT_TIMEOUT_MS = 150;
export const MAX_CONTEXT_TOKENS = 1_200;

const sessionLocks = new Map<string, Promise<void>>();

const withSessionLock = async <T>(
  sessionId: string,
  operation: () => Promise<T>,
): Promise<T> => {
  const previous =
    sessionLocks.get(sessionId) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  sessionLocks.set(sessionId, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release?.();
    if (sessionLocks.get(sessionId) === tail) {
      sessionLocks.delete(sessionId);
    }
  }
};

const stopWords = new Set([
  "and",
  "are",
  "for",
  "from",
  "how",
  "into",
  "the",
  "this",
  "that",
  "with",
]);

const normalizedTokens = (input: string): readonly string[] =>
  input
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .match(/[\p{L}\p{N}_-]+/gu) ?? [];

const distinct = <T>(input: readonly T[]): T[] =>
  [...new Set(input)];

const searchTerms = (request: ContextRequest): readonly string[] =>
  distinct(
    normalizedTokens([
      request.prompt,
      ...(request.fileHints ?? []),
    ].join("\n"))
      .filter((token) =>
        token.length >= 2 && !stopWords.has(token),
      ),
  ).slice(0, SEARCH_TERM_LIMIT);

const overlapRatio = (
  left: readonly string[],
  right: readonly string[],
): number => {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  if (leftSet.size === 0 || rightSet.size === 0) {
    return 0;
  }
  let overlap = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) {
      overlap += 1;
    }
  }
  return overlap / Math.min(leftSet.size, rightSet.size);
};

const nonApplicabilityMatches = (
  candidate: KnowledgeCandidate,
  requestTokens: readonly string[],
  requestText: string,
): boolean => {
  const normalizedRequest = requestText
    .normalize("NFKC")
    .toLocaleLowerCase("en-US");
  return candidate.nonApplicability.some((condition) => {
    const normalizedCondition = condition
      .normalize("NFKC")
      .toLocaleLowerCase("en-US");
    const conditionTokens = normalizedTokens(condition);
    return (
      normalizedCondition.length > 0 &&
      normalizedRequest.includes(normalizedCondition)
    ) || (
      conditionTokens.length >= 2 &&
      overlapRatio(conditionTokens, requestTokens) >= 0.6
    );
  });
};

const knowledgeContainsPotentialSecret = (
  candidate: KnowledgeCandidate,
): boolean =>
  [
    candidate.content,
    ...(candidate.scopeId === undefined
      ? []
      : [
          candidate.scopeId,
        ]),
    ...candidate.appliesWhen,
    ...candidate.nonApplicability,
  ].some(containsPotentialSecret);

const branchContextContainsPotentialSecret = (
  context: BranchContext,
): boolean =>
  [
    context.branch,
    context.goal,
    context.repoId,
    ...context.acceptedDecisions,
    ...context.explicitConstraints,
    ...context.implementationState,
    ...context.unfinishedItems,
  ].some(
    (value) =>
      value !== undefined &&
      containsPotentialSecret(value),
  );

const evidenceWeight = (
  candidate: KnowledgeCandidate,
): number => {
  switch (candidate.evidenceTier) {
    case "locked_preference":
      return 16;
    case "repeated_evidence":
      return 14;
    case "externally_verified":
      return 12;
    case "user_confirmed":
      return 10;
    case "disputed":
    case "inferred":
      return 0;
  }
};

const scopeWeight = (scope: Scope): number => {
  switch (scope) {
    case "branch":
      return 40;
    case "repository":
      return 30;
    case "workflow":
      return 20;
    case "personal":
      return 10;
  }
};

const freshnessWeight = (
  candidate: KnowledgeCandidate,
  now: Date,
): number => {
  const timestamp = Date.parse(
    candidate.validatedAt ?? candidate.createdAt,
  );
  const ageDays = Math.max(
    0,
    (now.getTime() - timestamp) / 86_400_000,
  );
  return Math.max(0, 8 - Math.floor(ageDays / 30));
};

const stalePenalty = (
  candidate: KnowledgeCandidate,
  now: Date,
): number => {
  if (candidate.expiresAt === undefined) {
    return 0;
  }
  const remainingDays =
    (Date.parse(candidate.expiresAt) - now.getTime()) /
    86_400_000;
  if (remainingDays <= 7) {
    return 15;
  }
  return remainingDays <= 30 ? 5 : 0;
};

interface AggregatedKnowledge {
  readonly candidate: KnowledgeCandidate;
  readonly matchedTerms: ReadonlySet<string>;
  readonly score: number;
}

const knowledgeRank = (
  input: AggregatedKnowledge,
  requestTokens: readonly string[],
  now: Date,
): number => {
  const candidate = input.candidate;
  const triggerTokens = normalizedTokens(
    candidate.appliesWhen.join("\n"),
  );
  const triggerWeight =
    overlapRatio(triggerTokens, requestTokens) * 15;
  const relevanceWeight =
    Math.min(20, input.matchedTerms.size * 4) +
    Math.min(
      10,
      Math.log1p(Math.max(0, input.score) * 1_000_000),
    );
  const applied = candidate.utility.applied;
  const utilityWeight =
    applied === 0
      ? 0
      : (
          candidate.utility.helpful -
          candidate.utility.harmful * 2
        ) / applied * 8;
  const contradictionPenalty =
    candidate.conflictsWith.length * 8;
  return (
    scopeWeight(candidate.scope) +
    relevanceWeight +
    triggerWeight +
    evidenceWeight(candidate) +
    freshnessWeight(candidate, now) +
    Math.max(-5, Math.min(5, candidate.importance)) +
    utilityWeight -
    contradictionPenalty -
    stalePenalty(candidate, now)
  );
};

const renderBranchContext = (
  context: BranchContext,
): ContextItem => {
  const sections = [
    context.goal === undefined
      ? undefined
      : `Goal: ${context.goal}`,
    context.acceptedDecisions.length === 0
      ? undefined
      : `Decisions: ${context.acceptedDecisions.join("; ")}`,
    context.explicitConstraints.length === 0
      ? undefined
      : `Constraints: ${context.explicitConstraints.join("; ")}`,
    context.implementationState.length === 0
      ? undefined
      : `State: ${context.implementationState.join("; ")}`,
    context.unfinishedItems.length === 0
      ? undefined
      : `Next: ${context.unfinishedItems.join("; ")}`,
  ].filter((value): value is string => value !== undefined);
  return {
    applicabilitySummary:
      `Exact branch ${context.branch} at ${context.headSha}.`,
    explanationRef:
      `branch-context:${context.branchContextId}`,
    guidance: sections.join("\n"),
    id: context.branchContextId,
    kind: "branch_context",
    rank: 10_000,
    scope: "branch",
    scopeId: context.branch,
  };
};

const renderKnowledge = (
  input: AggregatedKnowledge,
  requestTokens: readonly string[],
  now: Date,
): ContextItem => {
  const candidate = input.candidate;
  return {
    applicabilitySummary: [
      ...candidate.appliesWhen,
      ...candidate.nonApplicability.map(
        (condition) => `Not when: ${condition}`,
      ),
    ].join("; "),
    evidenceTier: candidate.evidenceTier,
    explanationRef: `knowledge:${candidate.knowledgeId}`,
    guidance: candidate.content,
    id: candidate.knowledgeId,
    kind: "knowledge",
    rank: knowledgeRank(input, requestTokens, now),
    scope: candidate.scope,
    ...(candidate.scopeId === undefined
      ? {}
      : {
          scopeId: candidate.scopeId,
        }),
  };
};

export const estimateRenderedTokens = (input: string): number => {
  let cjkCharacters = 0;
  let nonCjk = "";
  for (const character of input) {
    if (
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
        .test(character)
    ) {
      cjkCharacters += 1;
      nonCjk += " ";
    } else {
      nonCjk += character;
    }
  }
  const parts =
    nonCjk.match(/[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/gu) ?? [];
  return cjkCharacters + parts.reduce(
    (total, part) =>
      total + (
        /^[A-Za-z0-9_]+$/u.test(part)
          ? Math.max(1, Math.ceil(part.length / 4))
          : 1
      ),
    0,
  );
};

class RetrievalTimeoutError extends Error {
  public override readonly name = "RetrievalTimeoutError";

  public constructor() {
    super("Retrieval timed out.");
  }
}

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new RetrievalTimeoutError()),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
};

const explanationTarget = (
  explanationRef: string,
): {
  readonly id: string;
  readonly kind: ContextItem["kind"];
} | undefined => {
  const separator = explanationRef.indexOf(":");
  if (separator <= 0) {
    return undefined;
  }
  const prefix = explanationRef.slice(0, separator);
  const id = explanationRef.slice(separator + 1).trim();
  if (id.length === 0) {
    return undefined;
  }
  if (prefix === "knowledge") {
    return {
      id,
      kind: "knowledge",
    };
  }
  if (prefix === "branch-context") {
    return {
      id,
      kind: "branch_context",
    };
  }
  return undefined;
};

const feedbackKind = (
  action: ContextFeedbackAction,
): FeedbackEvent["kind"] => {
  switch (action) {
    case "helpful":
      return "strengthen";
    case "wrong":
      return "correct";
    case "confirm":
    case "irrelevant":
    case "mute_session":
    case "revoke":
    case "set_scope":
    case "stale":
      return action;
  }
};

const contextFeedback = (
  action: ContextFeedbackAction,
): ContextUseRecord["feedback"] | undefined => {
  switch (action) {
    case "helpful":
      return "helpful";
    case "irrelevant":
      return "irrelevant";
    case "mute_session":
      return "ignored";
    case "stale":
      return "stale";
    case "wrong":
      return "wrong";
    case "confirm":
    case "revoke":
    case "set_scope":
      return undefined;
  }
};

const feedbackScopeChange = (
  request: ContextFeedbackRequest,
): FeedbackEvent["scopeChange"] | undefined => {
  if (request.action !== "set_scope") {
    return undefined;
  }
  if (request.scope === undefined) {
    throw new Error(
      "set_scope feedback requires scope.",
    );
  }
  switch (request.scope) {
    case "personal":
      return {
        scope: "personal",
      };
    case "repository":
      if (request.repositoryScopeId === undefined) {
        throw new Error(
          "Repository scope feedback requires trusted repository identity.",
        );
      }
      return {
        scope: "repository",
        scopeId: request.repositoryScopeId,
      };
    case "workflow":
      if (request.workflowScopeId === undefined) {
        throw new Error(
          "Workflow scope feedback requires trusted workflow identity.",
        );
      }
      return {
        scope: "workflow",
        scopeId: request.workflowScopeId,
      };
    case "branch":
      if (
        request.repositoryScopeId === undefined ||
        request.branchScopeId === undefined
      ) {
        throw new Error(
          "Branch scope feedback requires trusted repository and branch identity.",
        );
      }
      return {
        scope: "branch",
        scopeId: branchScopeIdFor(
          request.repositoryScopeId,
          request.branchScopeId,
        ),
      };
  }
};

const updatedCandidate = (
  candidate: KnowledgeCandidate,
  request: ContextFeedbackRequest,
  now: Date,
): KnowledgeCandidate | undefined => {
  const timestamp = now.toISOString();
  switch (request.action) {
    case "helpful":
      return {
        ...candidate,
        utility: {
          ...candidate.utility,
          applied: candidate.utility.applied + 1,
          helpful: candidate.utility.helpful + 1,
        },
        validatedAt: timestamp,
      };
    case "wrong":
      return {
        ...candidate,
        evidenceTier: "disputed",
        state: "disputed",
        utility: {
          ...candidate.utility,
          applied: candidate.utility.applied + 1,
          harmful: candidate.utility.harmful + 1,
        },
        validatedAt: timestamp,
      };
    case "stale":
      return {
        ...candidate,
        expiresAt: timestamp,
        state: "archived",
        validatedAt: timestamp,
      };
    case "confirm":
      return {
        ...candidate,
        evidenceMarks: distinct([
          ...candidate.evidenceMarks,
          "user_confirmed",
        ]),
        evidenceTier:
          candidate.evidenceTier === "inferred" ||
          candidate.evidenceTier === "disputed"
            ? "user_confirmed"
            : candidate.evidenceTier,
        state: "active",
        validatedAt: timestamp,
      };
    case "revoke":
      return {
        ...candidate,
        state: "archived",
        validatedAt: timestamp,
      };
    case "set_scope": {
      const scopeChange = feedbackScopeChange(request);
      if (scopeChange === undefined) {
        throw new Error(
          "set_scope feedback requires a scope change.",
        );
      }
      if (scopeChange.scope !== "personal") {
        return {
          ...candidate,
          scope: scopeChange.scope,
          scopeId: scopeChange.scopeId,
          validatedAt: timestamp,
        };
      }
      const {
        scopeId: previousScopeId,
        ...withoutScopeId
      } = candidate;
      void previousScopeId;
      return {
        ...withoutScopeId,
        scope: "personal",
        validatedAt: timestamp,
      };
    }
    case "irrelevant":
    case "mute_session":
      return undefined;
  }
};

export interface ContextRetrievalServiceOptions {
  readonly backend: KnowledgeBackend;
  readonly clockMs?: () => number;
  readonly idGenerator?: () => string;
  readonly now?: () => Date;
  readonly store: CanonicalContextStore;
  readonly syncKnowledge?: (
    candidate: KnowledgeCandidate,
  ) => Promise<void>;
  readonly timeoutMs?: number;
}

export class ContextRetrievalService {
  readonly #backend: KnowledgeBackend;
  readonly #clockMs: () => number;
  readonly #idGenerator: () => string;
  readonly #now: () => Date;
  readonly #retriever: CanonicalKnowledgeRetriever;
  readonly #store: CanonicalContextStore;
  readonly #syncKnowledge:
    | ((candidate: KnowledgeCandidate) => Promise<void>)
    | undefined;
  readonly #timeoutMs: number;

  public constructor(options: ContextRetrievalServiceOptions) {
    const timeoutMs =
      options.timeoutMs ?? DEFAULT_CONTEXT_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError(
        "Context retrieval timeout must be positive.",
      );
    }
    this.#backend = options.backend;
    this.#clockMs = options.clockMs ?? Date.now;
    this.#idGenerator = options.idGenerator ?? randomUUID;
    this.#now = options.now ?? (() => new Date());
    this.#retriever = new CanonicalKnowledgeRetriever({
      backend: options.backend,
      store: options.store,
    });
    this.#store = options.store;
    this.#syncKnowledge = options.syncKnowledge;
    this.#timeoutMs = timeoutMs;
  }

  public async context(
    request: ContextRequest,
  ): Promise<ContextResponse> {
    const prompt = request.prompt.trim();
    const cwd = request.cwd.trim();
    const sessionId = request.sessionId.trim();
    if (
      prompt.length === 0 ||
      cwd.length === 0 ||
      sessionId.length === 0
    ) {
      throw new Error(
        "Context prompt, cwd, and sessionId must be non-empty.",
      );
    }
    if (
      !Number.isInteger(request.tokenBudget) ||
      request.tokenBudget <= 0
    ) {
      throw new RangeError(
        "Context tokenBudget must be positive.",
      );
    }
    const startedAt = this.#clockMs();
    const deadline = Date.now() + this.#timeoutMs;
    return withSessionLock(sessionId, () =>
      this.#context({
        ...request,
        cwd,
        prompt,
        sessionId,
      }, startedAt, deadline),
    );
  }

  async #context(
    request: ContextRequest,
    startedAt: number,
    deadline: number,
  ): Promise<ContextResponse> {
    const prompt = request.prompt;
    const sessionId = request.sessionId;
    const tokenBudget = Math.min(
      request.tokenBudget,
      MAX_CONTEXT_TOKENS,
    );
    const requestId = `context-${this.#idGenerator()}`;
    if (deadline <= Date.now()) {
      return {
        items: [],
        latencyMs: Math.max(
          0,
          Math.round(this.#clockMs() - startedAt),
        ),
        renderedTokens: 0,
        requestId,
        status: "degraded",
        statusDetail:
          "Retrieval deadline expired while waiting for the Session lock.",
      };
    }
    const now = request.now ?? this.#now();
    const previousRecords =
      this.#store.contextUseRecords(sessionId);
    const previouslyReturned = new Set(
      previousRecords.flatMap(
        (record) => record.returnedKnowledgeIds,
      ),
    );
    if (this.#store.sessionMuted(sessionId)) {
      const latencyMs = Math.max(
        0,
        Math.round(this.#clockMs() - startedAt),
      );
      this.#store.appendContextUseRecord({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        appliedKnowledgeIds: [],
        candidateKnowledgeIds: [],
        createdAt: now.toISOString(),
        latencyMs,
        renderedTokens: 0,
        requestId,
        returnedKnowledgeIds: [],
        sessionId,
      });
      return {
        items: [],
        latencyMs,
        renderedTokens: 0,
        requestId,
        status: "muted",
      };
    }

    let knowledge: readonly AggregatedKnowledge[];
    try {
      if (
        this.#backend.searchWithTimeout === undefined ||
        searchTerms(request).length === 0
      ) {
        const health =
          this.#backend.healthWithTimeout === undefined
            ? await withTimeout(
                this.#backend.health(),
                Math.max(1, deadline - Date.now()),
              )
            : await this.#backend.healthWithTimeout(
                Math.max(1, deadline - Date.now()),
              );
        if (health.status !== "healthy") {
          throw new Error(
            `Knowledge backend is unhealthy: ${health.quickCheck}.`,
          );
        }
      }
      knowledge = await this.#search(
        request,
        now,
        Math.max(1, deadline - Date.now()),
      );
    } catch (error) {
      const latencyMs = Math.max(
        0,
        Math.round(this.#clockMs() - startedAt),
      );
      this.#store.appendContextUseRecord({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        appliedKnowledgeIds: [],
        candidateKnowledgeIds: [],
        createdAt: now.toISOString(),
        latencyMs,
        renderedTokens: 0,
        requestId,
        returnedKnowledgeIds: [],
        sessionId,
      });
      return {
        items: [],
        latencyMs,
        renderedTokens: 0,
        requestId,
        status: "degraded",
        statusDetail:
          error instanceof Error
            ? error.message
            : "Knowledge retrieval failed.",
      };
    }

    const requestText = [
      prompt,
      ...(request.fileHints ?? []),
    ].join("\n");
    const requestTokens = normalizedTokens(requestText);
    const candidates: ContextItem[] = [];
    if (
      request.repoId !== undefined &&
      request.branch !== undefined &&
      request.headSha !== undefined
    ) {
      const branchContext = this.#store.branchContextFor({
        branch: request.branch,
        headSha: request.headSha,
        now,
        repoId: request.repoId,
      });
      if (
        branchContext !== undefined &&
        !branchContextContainsPotentialSecret(branchContext) &&
        !previouslyReturned.has(
          `branch-context:${branchContext.branchContextId}`,
        )
      ) {
        candidates.push(renderBranchContext(branchContext));
      }
    }
    candidates.push(
      ...knowledge
        .filter(
          (input) =>
            !previouslyReturned.has(
              `knowledge:${input.candidate.knowledgeId}`,
            ) &&
            !knowledgeContainsPotentialSecret(input.candidate) &&
            !nonApplicabilityMatches(
              input.candidate,
              requestTokens,
              requestText,
            ),
        )
        .map((input) =>
          renderKnowledge(input, requestTokens, now),
        ),
    );
    candidates.sort(
      (left, right) =>
        right.rank - left.rank ||
        left.id.localeCompare(right.id),
    );

    const items: ContextItem[] = [];
    for (const item of candidates) {
      if (items.length === MAX_CONTEXT_ITEMS) {
        break;
      }
      const next = [
        ...items,
        item,
      ];
      if (
        estimateRenderedTokens(JSON.stringify(next)) <=
        tokenBudget
      ) {
        items.push(item);
      }
    }
    const renderedTokens =
      items.length === 0
        ? 0
        : estimateRenderedTokens(JSON.stringify(items));
    const latencyMs = Math.max(
      0,
      Math.round(this.#clockMs() - startedAt),
    );
    const record: ContextUseRecord = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      appliedKnowledgeIds: [],
      candidateKnowledgeIds: knowledge.map(
        (input) => input.candidate.knowledgeId,
      ),
      createdAt: now.toISOString(),
      latencyMs,
      renderedTokens,
      requestId,
      returnedKnowledgeIds: items.map(
        (item) => item.explanationRef,
      ),
      sessionId,
    };
    if (!this.#store.appendContextUseRecord(record)) {
      return {
        items: [],
        latencyMs,
        renderedTokens: 0,
        requestId,
        status: "degraded",
        statusDetail:
          "Context use record could not be persisted.",
      };
    }
    return {
      items,
      latencyMs,
      renderedTokens,
      requestId,
      status: "ok",
    };
  }

  public explain(
    request: {
      readonly explanationRef: string;
      readonly sessionId: string;
    },
  ): ContextExplanation {
    const sessionId = request.sessionId.trim();
    const explanationRef = request.explanationRef.trim();
    const target = explanationTarget(explanationRef);
    if (target === undefined || sessionId.length === 0) {
      return {
        explanationRef,
        status: "not_found",
      };
    }
    const returned = new Set(
      this.#store.contextUseRecords(sessionId).flatMap(
        (record) => record.returnedKnowledgeIds,
      ),
    );
    if (!returned.has(explanationRef)) {
      return {
        explanationRef,
        status: "not_previously_retrieved",
      };
    }
    if (target.kind === "branch_context") {
      const context = this.#store.branchContexts().find(
        (candidate) =>
          candidate.branchContextId === target.id,
      );
      if (context === undefined) {
        return {
          explanationRef,
          status: "not_found",
        };
      }
      if (
        [
          context.branch,
          context.repoId,
        ].some(containsPotentialSecret)
      ) {
        return {
          explanationRef,
          status: "not_found",
        };
      }
      return {
        applicability: {
          branch: context.branch,
          expiresAt: context.expiresAt,
          headSha: context.headSha,
          repoId: context.repoId,
        },
        contradictoryEvidence: [],
        currentState:
          context.expiresAt !== undefined &&
          Date.parse(context.expiresAt) <= this.#now().getTime()
            ? "expired"
            : "active",
        explanationRef,
        id: context.branchContextId,
        kind: "branch_context",
        provenance: {
          recentVerificationEvidenceIds:
            context.recentVerificationEvidenceIds,
          sourceEpisodeIds: context.sourceEpisodeIds,
          sourceEventIds: context.sourceEventIds,
        },
        status: "available",
      };
    }
    const candidate = this.#store
      .knowledgeCandidates([
        target.id,
      ])[0];
    if (
      candidate === undefined ||
      this.#store
        .knowledgeCandidatesWithUnavailableSources([
          candidate,
        ])
        .has(candidate.knowledgeId)
    ) {
      return {
        explanationRef,
        status: "not_found",
      };
    }
    if (knowledgeContainsPotentialSecret(candidate)) {
      return {
        explanationRef,
        status: "not_found",
      };
    }
    const episodesById = new Map(
      this.#store.workEpisodes().map((episode) => [
        episode.episodeId,
        episode,
      ]),
    );
    const eventsById = new Map(
      this.#store.episodeSourceEnvelopes().map(
        (envelope) => [
          envelope.event.eventId,
          envelope,
        ],
      ),
    );
    const conflicting = this.#store.knowledgeCandidates(
      candidate.conflictsWith,
    );
    return {
      applicability: {
        appliesWhen: candidate.appliesWhen,
        expiresAt: candidate.expiresAt,
        nonApplicability: candidate.nonApplicability,
        scope: candidate.scope,
        scopeId: candidate.scopeId,
      },
      contradictoryEvidence: conflicting.map((item) => ({
        evidenceTier: item.evidenceTier,
        knowledgeId: item.knowledgeId,
        state: item.state,
      })),
      currentState: candidate.state,
      evidenceTier: candidate.evidenceTier,
      explanationRef,
      id: candidate.knowledgeId,
      kind: "knowledge",
      provenance: {
        sourceEpisodes: candidate.sourceEpisodeIds.map(
          (episodeId) => {
            const episode = episodesById.get(episodeId);
            return episode === undefined
              ? {
                  episodeId,
                }
              : {
                  episodeId,
                  finishedAt: episode.finishedAt,
                  goal: redactPotentialSecrets(episode.goal),
                  startedAt: episode.startedAt,
                };
          },
        ),
        sourceEvidence: candidate.sourceEvidenceIds.map(
          (evidenceId) => {
            const envelope = eventsById.get(evidenceId);
            return envelope === undefined
              ? {
                  evidenceId,
                }
              : {
                  evidenceId,
                  eventType: envelope.event.eventType,
                  timestamp: envelope.event.timestamp,
                  trust: envelope.event.trust,
                };
          },
        ),
      },
      status: "available",
    };
  }

  public async feedback(
    request: ContextFeedbackRequest,
  ): Promise<ContextFeedbackResponse> {
    const requestId = request.requestId.trim();
    const sessionId = request.sessionId.trim();
    const targetId = request.targetId.trim();
    if (
      requestId.length === 0 ||
      sessionId.length === 0 ||
      targetId.length === 0
    ) {
      throw new Error(
        "Feedback requestId, sessionId, and targetId must be non-empty.",
      );
    }
    const reason = request.reason?.trim();
    if (
      [
        reason,
        request.branchScopeId,
        request.repositoryScopeId,
        request.workflowScopeId,
      ].some(
        (value) =>
          value !== undefined &&
          containsPotentialSecret(value),
      )
    ) {
      throw new Error(
        "Feedback rejected content that may contain a secret.",
      );
    }
    const useRecord = this.#store
      .contextUseRecords(sessionId)
      .find((record) => record.requestId === requestId);
    if (
      useRecord === undefined ||
      !useRecord.returnedKnowledgeIds.includes(
        `knowledge:${targetId}`,
      )
    ) {
      return {
        status: "not_previously_retrieved",
      };
    }
    const candidate = this.#store
      .knowledgeCandidates([
        targetId,
      ])[0];
    if (
      candidate === undefined ||
      this.#store
        .knowledgeCandidatesWithUnavailableSources([
          candidate,
        ])
        .has(candidate.knowledgeId)
    ) {
      return {
        status: "not_found",
      };
    }
    const now = this.#now();
    const kind = feedbackKind(request.action);
    const scopeChange = feedbackScopeChange(request);
    const feedbackId = `feedback-${sha256({
      action: request.action,
      branchScopeId: request.branchScopeId,
      repositoryScopeId: request.repositoryScopeId,
      requestId,
      scope: request.scope,
      targetId,
      workflowScopeId: request.workflowScopeId,
    }).slice(0, 24)}`;
    const event: FeedbackEvent = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      evidenceRef:
        request.action === "mute_session"
          ? sessionId
          : requestId,
      feedbackId,
      kind,
      ...(reason === undefined || reason.length === 0
        ? {}
        : {
            reason,
          }),
      ...(scopeChange === undefined
        ? {}
        : {
            scopeChange: {
              scope: scopeChange.scope,
              ...(scopeChange.scopeId === undefined
                ? {}
                : {
                    scopeId: scopeChange.scopeId,
                  }),
            },
          }),
      source: "user",
      targetId,
      targetType: "knowledge",
      timestamp: now.toISOString(),
    };
    const feedback = contextFeedback(request.action);
    const marksApplied =
      request.action === "helpful" ||
      request.action === "wrong";
    const updatesCandidate =
      request.action !== "irrelevant" &&
      request.action !== "mute_session";
    const result = this.#store.recordKnowledgeFeedback({
      contextRequestId: requestId,
      event,
      ...(updatesCandidate
        ? {
            updateCandidate: (current) => {
              const updated = updatedCandidate(
                current,
                request,
                now,
              );
              if (updated === undefined) {
                throw new Error(
                  "Feedback action did not produce a Knowledge update.",
                );
              }
              return updated;
            },
          }
        : {}),
      updateContextUseRecord: (current) => ({
        ...current,
        appliedKnowledgeIds: marksApplied
          ? distinct([
              ...current.appliedKnowledgeIds,
                `knowledge:${targetId}`,
            ])
          : current.appliedKnowledgeIds,
        ...(feedback === undefined
          ? {}
          : {
              feedback,
            }),
      }),
    });
    if (!result.recorded) {
      if (
        updatesCandidate &&
        this.#syncKnowledge !== undefined
      ) {
        try {
          await this.#syncKnowledge(result.candidate);
          return {
            candidate: result.candidate,
            feedbackId,
            projectionStatus: "synchronized",
            recordedKind: kind,
            status: "already_recorded",
          };
        } catch (error) {
          return {
            candidate: result.candidate,
            feedbackId,
            projectionStatus: "degraded",
            recordedKind: kind,
            status: "already_recorded",
            statusDetail:
              error instanceof Error
                ? error.message
                : "Knowledge projection synchronization failed.",
          };
        }
      }
      return {
        feedbackId,
        recordedKind: kind,
        status: "already_recorded",
      };
    }
    const nextCandidate =
      updatesCandidate ? result.candidate : undefined;
    if (
      nextCandidate !== undefined &&
      this.#syncKnowledge !== undefined
    ) {
      try {
        await this.#syncKnowledge(nextCandidate);
      } catch (error) {
        return {
          candidate: nextCandidate,
          feedbackId,
          projectionStatus: "degraded",
          recordedKind: kind,
          status: "recorded",
          statusDetail:
            error instanceof Error
              ? error.message
              : "Knowledge projection synchronization failed.",
        };
      }
    }
    return {
      ...(nextCandidate === undefined
        ? {}
        : {
            candidate: nextCandidate,
          }),
      feedbackId,
      ...(nextCandidate === undefined
        || this.#syncKnowledge === undefined
        ? {}
        : {
            projectionStatus: "synchronized" as const,
          }),
      recordedKind: kind,
      status: "recorded",
    };
  }

  async #search(
    request: ContextRequest,
    now: Date,
    timeoutMs: number,
  ): Promise<readonly AggregatedKnowledge[]> {
    const terms = searchTerms(request);
    if (terms.length === 0) {
      return [];
    }
    const anchorTerm = [...terms].sort(
      (left, right) =>
        right.length - left.length ||
        left.localeCompare(right),
    )[0];
    if (anchorTerm === undefined) {
      return [];
    }
    const hits = await withTimeout(
      this.#retriever.search(
        {
          limit: SEARCH_RESULT_LIMIT,
          now,
          text: anchorTerm,
          ...(request.branch === undefined
            ? {}
            : {
                branchScopeId: request.branch,
              }),
          ...(request.repoId === undefined
            ? {}
            : {
                repositoryScopeId: request.repoId,
              }),
          ...(request.workflowScopeId === undefined
            ? {}
            : {
                workflowScopeId: request.workflowScopeId,
              }),
        },
        {
          timeoutMs,
        },
      ),
      timeoutMs,
    );
    return (hits as readonly RetrievedKnowledge[]).map((hit) => {
      const candidateTokens = new Set(
        normalizedTokens([
          hit.candidate.topicKey,
          hit.candidate.content,
          ...hit.candidate.appliesWhen,
        ].join("\n")),
      );
      return {
        candidate: hit.candidate,
        matchedTerms: new Set(
          terms.filter((term) => candidateTokens.has(term)),
        ),
        score: hit.score,
      };
    });
  }
}
