# ProvenLoop Implementation Roadmap

**Status:** Proposed execution plan  
**Updated:** 2026-08-28

## 1. Delivery strategy

Build the learning loop in evidence order. Do not begin with automatic Skill
generation. First prove that ProvenLoop can capture work safely, reconstruct a
task, link it to real outcomes, and retrieve useful knowledge without adding
noise.

## 2. Phase 0: Observation foundation

Deliver:

- TypeScript monorepo and CLI skeleton;
- Copilot plugin packaging;
- lifecycle hook ingestion;
- canonical event schema and validation;
- write-time secret redaction;
- persistent queue and single shared worker;
- SQLite event store;
- repository, branch, session, commit, and tool identities;
- lightweight evaluation runner contract;
- Requirement Manifest and Replay Spec schemas;
- append-only Evidence Ledger;
- deterministic Gate results, JSON/Markdown reports, and stable exit codes;
- `provenloop doctor`;
- fixture-based parser tests.

Acceptance:

- Copilot remains usable when ProvenLoop is stopped or broken;
- hook overhead is negligible and bounded;
- duplicate events are idempotent;
- malformed events are visible and never silently accepted;
- common secrets are not persisted;
- internal worker sessions do not recursively re-enter the queue;
- a fixture that claims a required process completed without invocation evidence
  fails with a non-zero evaluation exit code;
- detected-but-unused participants cannot be counted as completed work.

This phase does not build a full sandbox, dashboard, annotation platform, or
M3-M6 evaluation suite. It establishes the stable evaluation protocol that
later phases extend.

## 3. Phase 1: Work Episodes and safe memory

Deliver:

- Work Episode builder;
- branch context extraction;
- explicit remember/correct/forget operations;
- topic-keyed Knowledge Cards;
- SQLite FTS5 retrieval;
- scope filtering;
- `provenloop_context`;
- `provenloop_explain`;
- per-session deduplication and token ceiling.

Acceptance:

- a task spanning two sessions is reconstructed into one episode;
- a new session on the same branch retrieves relevant compressed context;
- unrelated repositories receive no repository knowledge;
- context returns no more than the configured budget;
- users can trace and delete every retrieved item.

## 4. Phase 2: Outcome Linker

Deliver:

- test and build result normalization;
- commit, PR, review, issue, fix, and revert links;
- user-correction detection;
- outcome confidence model;
- retrospective analyzer;
- strengthen, weaken, dispute, and supersede feedback;
- baseline behavior metrics.

Acceptance:

- a later revert weakens the earlier episode;
- a review correction identifies the earlier missing check;
- conflicting evidence pauses automatic retrieval;
- every retrospective conclusion cites concrete evidence;
- unsupported model inference cannot become active knowledge.

This phase is ProvenLoop's first major product differentiator.

## 5. Phase 3: Skill Candidate preview

Deliver:

- cross-episode pattern mining;
- stable Skill keys;
- generated Skill draft with triggers, negative triggers, procedure,
  permissions, validation, and provenance;
- secret and prompt-injection scans;
- candidate diff;
- approve, reject, edit, and expire actions;
- no automatic activation.

Acceptance:

- single-event lessons remain Knowledge Cards;
- repeated verified workflows may produce one consolidated candidate;
- a candidate contains no temporary path or credential;
- candidate source episodes are inspectable;
- rejection prevents repeated regeneration without new evidence.

## 6. Phase 4: Evaluation, canary, and rollback

Deliver:

- historical replay dataset using the existing evaluation runner;
- held-out episode selection;
- no-memory, memory-only, old-Skill, and candidate-Skill comparisons;
- trigger negative tests;
- sandbox execution provider for the existing runner;
- immutable Skill registry;
- canary activation;
- one-command rollback.

Acceptance:

- candidates cannot pass only by replaying their source episodes;
- promotion requires measurable improvement over baseline;
- safety and scope regressions block promotion;
- approved versions are immutable;
- rollback restores the prior active version and records an audit event.

## 7. Phase 5: Optional ecosystem expansion

Possible work:

- Memorix backend integration after the fallback backend is stable;
- Claude Code and Codex adapters;
- local web review UI;
- team-scoped approved knowledge;
- remote sandbox execution;
- OpenClaw notifications or long-running scheduling;
- Hermes-assisted research or validation;
- parameter training from approved datasets.

None of these is required to validate the core product.

## 8. MVP cut

The recommended first demonstrable product includes:

```text
Copilot events + Git + tests
          |
          v
     Work Episode
          |
          v
     Outcome Linker
          |
          v
evidence-backed Knowledge Card
          |
          v
retrieval in a later session
          |
          v
measured reduction in correction
```

Must-have:

- one-command plugin installation;
- non-blocking capture;
- repository and branch identity;
- cross-session Work Episode;
- correction and test outcome recognition;
- scoped Knowledge Card;
- MCP retrieval and explanation;
- feedback and deletion;
- metrics for corrections, retries, and repeated context.

Demonstration-only extension:

- generate one Skill Candidate and show its evidence;
- do not automatically activate it.

## 9. Demonstration scenario

1. In the first session, Copilot assumes Jest. The user corrects it to inspect
   package scripts and use targeted Vitest. The test succeeds.
2. ProvenLoop links the correction and successful test into one Work Episode,
   then qualifies repository-scoped testing guidance.
3. In a new session, Copilot receives only that relevant guidance and chooses
   the correct targeted test without another correction.
4. Metrics show fewer failed commands and zero repeated user correction.
5. After another independent success, ProvenLoop may show a Skill Candidate,
   but it remains inactive pending evaluation and approval.

## 10. Explicitly deferred

- online model fine-tuning;
- generic agent orchestration;
- full session viewer;
- knowledge graph;
- custom vector database;
- automatic high-permission Skill activation;
- team-wide synchronization;
- automatic modification of repository instruction files;
- mandatory post-session summaries;
- comprehensive dashboard.

## 11. Initial work packages

### Package A: Plugin and ingestion

- plugin manifest;
- hooks;
- event envelope;
- redaction;
- queue;
- diagnostics.

### Package B: Domain core

- SQLite schema;
- repository identity;
- event normalization;
- episode builder;
- outcome linker.

### Package C: Retrieval

- Knowledge backend interface;
- FTS backend;
- Branch Context;
- ranking;
- token budgeting;
- MCP tools.

### Package D: Governance

- provenance;
- feedback lifecycle;
- conflict handling;
- deletion propagation;
- Skill candidate state.

### Package E: Evaluation

- metrics;
- replay fixtures;
- baseline runner;
- held-out selection;
- report generation.

## 12. Go/no-go criteria

Continue beyond Phase 2 only if real usage demonstrates:

- correct cross-session episode reconstruction;
- useful retrieval precision;
- measurable reduction in repeated correction or failed retries;
- no cross-repository leakage;
- acceptable interactive latency;
- reliable provenance and deletion.

If these are not achieved, Skill generation would only automate low-quality
learning and should remain disabled.
