# ProvenLoop Implementation Roadmap

**Status:** Milestone plan; implementation is not release acceptance

**Updated:** 2026-09-07

## 1. Delivery strategy

Build the learning loop in evidence order. Do not begin with automatic Skill
generation. First deliver a narrow useful path: an explicitly confirmed scoped
rule, retrieval in a later Session, explanation, explicit feedback, and local
observations. Safe capture and strict evidence qualification support that
path; automated delayed outcome discovery is not a prerequisite.

The `0.1.0-alpha.0.11` Windows Design Partner Preview evidence candidate includes
M0-M2 repairs, Knowledge review, trusted feedback, local observations, and
bounded current-session reconciliation. `0.1.0-alpha.1` remains an unapproved
quality-release target; new-version validation and field acceptance require
retained evidence. Synthetic replay validates regressions, observational use
records behavior, and controlled comparisons establish benefit. These are
different evidence levels.

## 2. M0: Observation foundation

Deliver:

- TypeScript monorepo and CLI skeleton;
- Copilot plugin packaging;
- Copilot Extension session-event ingestion;
- canonical event schema and validation;
- write-time secret redaction;
- bounded persistent queue processing and a leased shared worker;
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
- capture-added latency is negligible and bounded;
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

## 3. M1: Trusted continuity memory

Deliver:

- Work Episode builder;
- branch context extraction;
- explicit remember/correct/forget and review/confirm/replace/revoke operations;
- topic-keyed Knowledge Cards;
- SQLite FTS5 retrieval;
- scope filtering;
- `provenloop_context`;
- `provenloop_explain`;
- per-session deduplication and token ceiling;
- trusted live Session identity, MCP instructions, and explicit feedback approval;
- privacy-minimized observation summaries and export.

Acceptance:

- a task spanning two sessions is reconstructed into one episode;
- a new session on the same branch retrieves relevant compressed context;
- unrelated repositories receive no repository knowledge;
- context returns no more than the configured budget;
- users can trace and delete every retrieved item.

## 4. M2: Evidence-backed correction learning

Deliver:

- explicit Correction Keys and predeclared Correction Opportunities;
- supported native event normalization through the production capture path;
- trusted correction/operation/verification binding with complete parent evidence;
- evidence tiers, deterministic admission, and explainable supersession;
- direct linked counterevidence and current explicit user resolution;
- synthetic recurrence regressions and separate real-use observation.

Acceptance:

- unrelated tests, incomplete targets, and unknown workspace identity cannot verify a rule;
- old user confirmation cannot resolve new counterevidence;
- conflicting evidence pauses automatic retrieval;
- recalled guidance cannot become independent support for itself;
- offered context, reported adoption, and successful outcomes stay distinct.

M1 + M2 form the first product-validation scope. Built-in 32-pair continuation
and 24-pair recurrence datasets are synthetic; their percentages do not satisfy
the real-effect acceptance requirement.

## 5. M3: Delayed Outcome Evidence Learning — future

Deliver:

- automated PR, review, CI, fix, bug, and revert discovery/association;
- direct, plausible, uncertain, and unrelated link strengths;
- configurable outcome qualification and censored windows;
- strengthen, weaken, dispute, and supersede from linked evidence.

Acceptance:

- later same-cause failures can revise earlier apparent success;
- uncertain links cannot independently change Knowledge authority;
- uncompleted observation windows do not count as final success;
- every outcome link is explainable and correctable.

## 6. M4: Deep Retrospective — future

Deliver cross-Episode comparisons, multiple hypotheses, local evidence
expansion, opt-in external research, counterexample search, and Insight
Candidates. Evaluate evidence completeness, unsupported causality, and
held-out usefulness. A plausible summary cannot activate Knowledge.

## 7. M5: Evaluated Playbooks — future

Deliver:

- cross-Episode pattern mining and versioned Skill drafts;
- triggers, negative triggers, permissions, validation, and provenance;
- secret/prompt-injection scans and human-readable candidate diffs;
- historical replay dataset using the existing evaluation runner;
- held-out episode selection;
- no-memory, memory-only, old-Skill, and candidate-Skill comparisons;
- trigger negative tests;
- sandbox execution provider for the existing runner;
- explicit approval and an immutable Playbook registry;
- canary activation;
- one-command rollback.

Acceptance:

- candidates cannot pass only by replaying their source episodes;
- promotion requires measurable improvement over baseline;
- safety and scope regressions block promotion;
- approved versions are immutable;
- rollback restores the prior active version and records an audit event;
- single-event lessons remain Knowledge; no automatic activation is allowed.

### M6: Additional Agent adapters — future

Add Reader and Observer adapters, shared scope/feedback semantics,
cross-Agent identity and deduplication, and capability-specific degradation.
No adapter may invent events it cannot observe.

### Other optional expansion

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

## 8. First-use cut and MVP validation

The recommended first demonstrable product includes:

```text
explicitly user-confirmed scoped rule
          |
          v
canonical Knowledge + Explain
          |
          v
retrieval in a later Session
          |
          v
explicit user feedback / reported adoption
          |
          v
local observational summary
          |
          v
later controlled evaluation of benefit
```

Must-have:

- one-command plugin installation;
- non-blocking capture;
- repository and branch identity;
- safe cross-session identity and Work Episode projection;
- correction and test recognition with strict operation proof;
- scoped Knowledge Card;
- MCP retrieval and explanation;
- feedback and deletion;
- review/confirm/replace/revoke and explicit adoption controls;
- bounded observation with missing outcomes represented as unknown.

Not required for the first useful demonstration:

- automated delayed Outcome linking or retrospective analysis;
- a Skill Candidate;
- productivity numbers unsupported by controlled measurements.

## 9. Demonstration scenario

1. In the repository, explicitly remember “inspect package scripts and use the
   targeted test” with a narrow applicability condition.
2. Review the rule, source, scope, and current digest. Correct, replace, revoke,
   or forget it if needed.
3. In a later Copilot Session, request relevant Context and Explain. Absence of
   a match or trusted identity is reported honestly.
4. After trying the rule, approve the exact feedback proposal yourself. Report
   adoption separately from helpfulness.
5. Inspect local observations. They show recorded use, not a counterfactual
   claim of fewer errors or time saved.

See the [executable workflow](../README.md#first-useful-workflow). An optional
automatic-learning demonstration must capture the real user correction,
trusted operation, parent chain, and successful bound verification through the
installed producer path. A domain fixture or same-Episode success is insufficient.

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
- Session event Extension;
- event envelope;
- redaction;
- queue;
- diagnostics.

### Package B: Domain core

- SQLite schema;
- repository identity;
- event normalization;
- episode builder;
- correction proof and admission; delayed Outcome linking remains M3.

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

Broader rollout and increasingly autonomous learning require real evidence of:

- correct cross-session episode reconstruction;
- useful retrieval precision;
- measurable reduction in repeated correction or failed retries;
- no cross-repository leakage;
- acceptable interactive latency;
- reliable provenance and deletion.

These requirements do not prevent a safe, explicitly bounded first-use
observation pilot. They do prevent claims of demonstrated benefit or quality
release approval. The current MVP gate retains a blocked controlled-field-effect
check; neither synthetic fixtures nor observational exports can clear it.
Skill generation remains deferred rather than automating unproven learning.
