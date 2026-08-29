# ProvenLoop Implementation Checklist

**Status:** Active  
**Updated:** 2026-08-28  
**Immediate target:** M0 observation foundation, followed by the M1 + M2
validated MVP.

This checklist turns the product design, architecture, roadmap, and validation
documents into an executable delivery order. Work is complete only when its
behavior is covered by the evaluation spine; code completion alone is not
completion.

## 1. Delivery rules

- [ ] Keep the MVP a TypeScript/Node.js modular monolith: a small Copilot
  capture Extension and one shared local host.
- [ ] Treat SQLite domain state as canonical; FTS, rendered context, and agent
  assets are rebuildable projections.
- [ ] Keep Extension callbacks bounded: copy allowed fields, enqueue to memory,
  and return without synchronous I/O.
- [ ] Fail closed for retrieval and learning; failure must never block normal
  Copilot use or fabricate successful state.
- [ ] Require stable IDs, provenance, scope, evidence state, and deletion state
  for every persisted or retrieved item.
- [ ] Add a Requirement Manifest, Replay Spec, deterministic verifier, and
  expected evidence for every product or safety promise.
- [ ] Record errors explicitly; do not silently accept malformed events,
  unknown versions, failed inference, or incomplete process claims.
- [ ] Implement and accept Windows 10/11 first. Keep platform-sensitive behavior
  behind explicit interfaces.
- [ ] Do not implement automatic Playbook generation or activation before M1
  and M2 pass their Go/No-Go gates.

## 2. Dependency order

```text
F0 integration spikes
  -> workspace and shared contracts
  -> evaluation spine
  -> redaction and durable queue
  -> canonical SQLite and worker
  -> Copilot adapter and control CLI
  -> basic Work Episode builder
  -> M0 acceptance
  -> M1 Branch Context and retrieval
  -> M2 correction learning
  -> M1 + M2 product evaluation
```

Independent work may proceed in parallel only after its shared contracts are
frozen.

## 3. F0: feasibility decisions

### 3.1 Copilot integration spike

- [x] Record the first supported Copilot CLI version range.
- [x] Verify available lifecycle hooks and their payload/version behavior.
- [x] Verify local MCP registration, startup, shutdown, and stdio behavior.
- [ ] Verify plugin install, upgrade, disable, uninstall, and idempotent
  reinstallation. Local marketplace lifecycle passes; remote upgrade remains
  blocked by F0-003.
- [x] Verify internal ProvenLoop work can be marked with
  `PROVENLOOP_INTERNAL=1`.
- [x] Verify supported background inference can reuse the existing Copilot
  sign-in without copying credentials, an additional API key, or per-call
  authorization.
- [x] Document degradation when Copilot is signed out, rate-limited, or
  incompatible.
- [x] Prove hook and MCP failure do not block foreground Copilot use.
- [x] Select the Extension event stream as the primary capture candidate and
  document its fallback, privacy, recovery, and Go/No-Go design.
- [x] Verify a plugin Extension can join the active Session and subscribe to
  required `session.on(...)` events.
- [x] Verify Extension callbacks are notification-only and do not wait for
  persistence or downstream processing.
- [x] Verify the Extension excludes registered internal Session IDs before
  copying content.
- [x] Verify Extension opt-in persists for ordinary `copilot` launches and a
  settings-based rollback stops Extension loading.
- [ ] Verify plugin disable and uninstall preserve prior user experimental
  settings while stopping the Extension.
- [x] Measure at least 500 Extension events on Windows 11 and verify required
  event coverage, event IDs, delivery freshness, callback work duration,
  failure isolation, and metadata-only persistence.
- [x] Accept the Extension event stream as feasible and unblock Batch 1
  workspace and shared-contract implementation.
- [ ] Complete F0-001 with Windows 10, paired foreground A/B latency,
  cancel/resume/subagent coverage, concurrent load and queue-failure tests,
  Session file reconciliation, and installed-plugin lifecycle validation
  before M0 acceptance.

### 3.2 Local runtime spike

- [x] Select and verify the SQLite driver on Node.js 22 for Windows packaging,
  WAL, transactions, migrations, and FTS5.
- [x] Verify atomic queue writes and replacement behavior on Windows.
- [x] Verify the process lease or named-mutex approach releases correctly after
  crashes.
- [x] Define the Windows data-root, log, artifact, queue, and evaluation paths.
- [x] Measure cold start, idle memory, queue throughput, and baseline capture
  overhead.

### 3.3 Exit criteria

- [x] Capture the decisions in architecture decision records or the relevant
  architecture sections.
- [x] Convert every unresolved feasibility risk into a blocking issue with an
  owner and a testable exit condition.
- [x] Do not begin broad implementation while authentication reuse, capture
  non-blocking behavior, or SQLite packaging remains unproven.

## 4. Batch 1: repository and contract foundation

### 4.1 Workspace

- [x] Initialize Git and add ignore rules for dependencies, builds, local
  ProvenLoop data, logs, and evaluation output.
- [x] Create a Node.js 22 TypeScript workspace with strict type checking.
- [x] Establish packages or modules for:
  - `contracts`
  - `domain`
  - `platform-windows`
  - `storage-sqlite`
  - `evaluation`
  - `copilot-adapter`
  - `host`
  - `cli`
  - `testkit`
- [x] Add standard scripts: `build`, `typecheck`, `lint`, `test`, and
  `test:integration`.
- [x] Add CI that runs clean install, type checking, tests, and build.
- [x] Establish versioning for schemas, migrations, fixtures, and reports.

### 4.2 Shared schemas

- [x] Implement runtime-validated schemas for `RawEvent`.
- [x] Implement schemas for `WorkEpisode`, `BranchContext`, `CorrectionKey`,
  `OutcomeEvidenceLink`, `KnowledgeCandidate`, and `FeedbackEvent`.
- [x] Implement schemas for `ProcessClaim`, `ContextUseRecord`, and
  `CorrectionOpportunity`.
- [x] Implement `RequirementManifest`, `ReplaySpec`, `EvidenceLedgerEntry`, and
  `GateResult`.
- [x] Freeze evaluation exit codes:
  - `0`: required gates passed
  - `1`: product or safety gate failed
  - `2`: invalid manifest, spec, or input
  - `3`: infrastructure error
- [x] Add schema compatibility tests and invalid-input fixtures.

### 4.3 Definition of done

- [x] Public package boundaries contain no Windows-specific types except the
  platform package.
- [x] Every persisted schema has an explicit version and migration strategy.
- [x] Unknown enum values and source versions follow an explicit compatibility
  or error path.
- [x] The entire empty workspace builds and tests successfully from a clean
  checkout.

## 5. Batch 2: evaluation spine first

### 5.1 Runner

- [ ] Implement `provenloop eval run --suite <suite> --out <directory>`.
- [ ] Implement `provenloop eval report --run <run-id>`.
- [ ] Load and validate Requirement Manifests and Replay Specs.
- [ ] Write an append-only Evidence Ledger for each evaluation run.
- [ ] Produce stable `report.json` and `report.md`.
- [ ] Return the documented exit code without converting gate failures into
  infrastructure failures.

### 5.2 Initial deterministic verifiers

- [ ] Event schema and source-version verifier.
- [ ] Event idempotency verifier.
- [ ] Process-claim execution consistency verifier.
- [ ] Participant and resolved-model identity verifier.
- [ ] Command completion and exit-code verifier.
- [ ] Secret persistence verifier.
- [ ] Repository-scope isolation verifier.
- [ ] Deletion propagation verifier contract, even if its full implementation
  lands with deletion support.

### 5.3 Initial replay fixtures

- [ ] Valid supported event.
- [ ] Malformed event that must remain visible and fail validation.
- [ ] Duplicate event that must create one canonical fact.
- [ ] Declared test completion with no invocation evidence.
- [ ] Detected participant that was never invoked.
- [ ] Requested model different from the resolved model.
- [ ] Seeded credential and high-entropy secret payloads.
- [ ] Unknown adapter version.
- [ ] Queue interruption and recovery.

### 5.4 Definition of done

- [ ] Fixtures can intentionally pass, fail, or become inconclusive.
- [ ] A false completion or false consensus claim exits with code `1`.
- [ ] Invalid fixture/schema input exits with code `2`.
- [ ] Reports identify requirement IDs, evidence IDs, fixture versions, and
  failure messages.

## 6. Batch 3: safe event capture

### 6.1 Event envelope and identity

- [ ] Generate stable event IDs and deduplication keys.
- [ ] Record adapter name/version, timestamp, trust label, session, repository,
  branch, worktree, commit, tool, operation, actor, and participant identities
  when available.
- [ ] Keep requested provider/model separate from resolved provider/model.
- [ ] Keep process declaration separate from verified completion evidence.
- [ ] Never inject raw events directly into model context.

### 6.2 Redaction

- [ ] Redact known credential formats before queue persistence.
- [ ] Add entropy-based detection for unknown token formats.
- [ ] Minimize stored tool arguments and result bodies.
- [ ] Preserve a safe error and digest when content is removed.
- [ ] Add a second redaction pass to the future retrieval boundary.
- [ ] Test false positives as well as seeded-secret recall.

### 6.3 Persistent queue

- [ ] Implement atomic append or atomic file replacement.
- [ ] Implement `pending`, `claimed`, `acknowledged`, `retry`, and `dead-letter`
  states.
- [ ] Add bounded retry with explicit last error and next-attempt time.
- [ ] Recover claimed items after process failure.
- [ ] Retain successful items only for the configured diagnostic period.
- [ ] Prevent recursive events marked `PROVENLOOP_INTERNAL=1`.

### 6.4 Extension capture

- [ ] Join the active Copilot Session and subscribe to required events.
- [ ] Copy allowed fields into a bounded in-memory buffer.
- [ ] Redact and enqueue through an asynchronous writer.
- [ ] Emit explicit `capture_gap` records on overflow or interrupted delivery.
- [ ] Return control without waiting for worker availability or persistence.
- [ ] Surface capture degradation through status and logs without failing
  Copilot.
- [ ] Reconcile supported Session files after gaps and restarts.
- [ ] Benchmark capture-added latency.

### 6.5 Definition of done

- [ ] Supported-event recognition precision is at least 95%.
- [ ] Capture-added latency P95 is at most 10 ms.
- [ ] Seeded secrets persisted by capture are zero.
- [ ] Duplicate events create no duplicate canonical facts.
- [ ] Unknown and malformed events are observable and never silently accepted.

## 7. Batch 4: canonical storage and shared worker

### 7.1 Database

- [ ] Create versioned, transactional migrations.
- [ ] Enable and test WAL and busy-timeout behavior.
- [ ] Create canonical tables for raw events, parser errors, identities, queue
  state, episodes, evidence links, process claims, feedback, deletions, metrics,
  and evaluation runs.
- [ ] Store source IDs and content digests on all derived records.
- [ ] Keep projection schemas outside domain lifecycle authority.
- [ ] Test migration upgrade, failed migration recovery, and database restore.

### 7.2 Worker

- [ ] Acquire a Windows process lease or named mutex.
- [ ] Claim queue items in bounded batches.
- [ ] Parse adapter events into canonical events.
- [ ] Commit one processing unit transactionally.
- [ ] Acknowledge only after the canonical transaction succeeds.
- [ ] Yield to interactive MCP requests and open a circuit breaker under CPU,
  memory, disk, provider-error, or queue-pressure conditions.
- [ ] Preserve durable backlog while a consumer or model provider is disabled.

### 7.3 Parser

- [ ] Normalize every supported Copilot event type.
- [ ] Record unsupported events through an explicit compatibility path.
- [ ] Preserve the safe raw envelope and parser error on failure.
- [ ] Distinguish a declared capability from an observed successful event.
- [ ] Add fixture-based parser tests for every supported source version.

### 7.4 Definition of done

- [ ] A fixture travels end to end from Extension envelope to redacted queue item,
  worker processing, canonical SQLite row, Ledger evidence, and gate result.
- [ ] Worker crashes do not lose acknowledged or pending work.
- [ ] Failed transactions do not create success-shaped domain state.
- [ ] Disabling a consumer stops its side effects without corrupting the queue.

## 8. Batch 5: Copilot adapter and operational CLI

### 8.1 Adapter

- [ ] Implement the `AgentAdapter` contract.
- [ ] Register the supported Extension and local MCP configuration.
- [ ] Resolve session, repository, branch, worktree, and commit identity.
- [ ] Publish an actual capability matrix for the installed Copilot version.
- [ ] Detect internal ProvenLoop sessions and suppress recursive capture.
- [ ] Tolerate unsupported Copilot versions without breaking the CLI.

### 8.2 CLI

- [ ] `provenloop install`
- [ ] `provenloop status`
- [ ] `provenloop doctor`
- [ ] `provenloop enable <capability>`
- [ ] `provenloop disable <capability>`
- [ ] `provenloop uninstall`
- [ ] Preserve data on uninstall unless purge is explicitly requested.
- [ ] Make install, enable, disable, and uninstall idempotent.

### 8.3 Doctor checks

- [ ] Node and Windows compatibility.
- [ ] Data-root permissions and free disk.
- [ ] SQLite health and migration version.
- [ ] Queue health, backlog, retry, and dead-letter count.
- [ ] Worker lease and recent heartbeat.
- [ ] Copilot version, sign-in availability, Extension registration, and MCP
  registration.
- [ ] Capability state and last explicit error for each consumer.
- [ ] Redaction and end-to-end synthetic-event self-test.

### 8.4 Definition of done

- [ ] ProvenLoop can be stopped or broken while Copilot remains usable.
- [ ] Installation requires no wrapper command for ordinary Copilot use.
- [ ] Daily operation requires no additional model API key.
- [ ] Capability disable stops only the selected capture, retrieval, or worker
  behavior.

## 9. Batch 6: basic Work Episode builder

### 9.1 Deterministic grouping

- [ ] Group by repository before applying weaker signals.
- [ ] Use branch, commit ancestry, PR/issue references, changed-file overlap,
  tests/errors, task semantics, temporal proximity, and explicit links.
- [ ] Store association evidence and confidence.
- [ ] Prefer conservative splits over harmful merges.
- [ ] Keep low-confidence associations as candidates.
- [ ] Support user correction of merge and split decisions in the domain model.

### 9.2 Episode state

- [ ] Record sessions, branches, commits, PRs, issues, timing, corrections, and
  outcome evidence references.
- [ ] Keep `outcome` separate from `outcomeQualification`.
- [ ] Do not treat an open or censored success as a final training example.
- [ ] Rebuild episode projections deterministically from canonical evidence.

### 9.3 Evaluation

- [ ] Prepare 20-50 anonymized real or realistic episodes.
- [ ] Label same-episode and different-episode pairs.
- [ ] Report precision, recall, wrong merge, and wrong split separately.
- [ ] Record ambiguous cases rather than forcing a confident label.

### 9.4 Definition of done

- [ ] Association precision is at least 95%.
- [ ] Association recall is at least 90%.
- [ ] Wrong merges are visible as a distinct release metric.
- [ ] Every episode relation can be explained using concrete source evidence.

## 10. M0 release checklist

- [ ] All Batch 1-6 definitions of done pass.
- [ ] M0 Requirement Manifests and Replay Specs are versioned and frozen.
- [ ] Event/process integrity, secret, scope, idempotency, and recovery suites
  pass.
- [ ] Unsupported Completion Claim count is zero.
- [ ] Seeded secret persistence and cross-repository leakage are zero.
- [ ] Capture-added latency P95 is at most 10 ms.
- [ ] Parser and episode-builder quality thresholds pass.
- [ ] `provenloop doctor` reports actionable failures.
- [ ] `report.json`, `report.md`, Evidence Ledger, dataset versions, and code
  version are retained for the release decision.
- [ ] Known failures and limitations are included in the report.
- [ ] M0 remains observation-only: no automatic long-term Knowledge activation.

## 11. M1: trusted continuity memory

### 11.1 Branch Context

- [ ] Build Branch Context only after material continuation state changes.
- [ ] Store goal, accepted decisions, constraints, implementation state,
  unfinished work, and recent verification evidence.
- [ ] Verify repository, branch, and HEAD before retrieval.
- [ ] Stop automatic recall after branch merge/deletion or context expiry.
- [ ] Keep Branch Context a rebuildable short-lived projection.

### 11.2 Knowledge backend

- [ ] Implement `KnowledgeBackend` without leaking backend-specific schema into
  domain code.
- [ ] Implement the SQLite FTS5/BM25 backend.
- [ ] Implement index, search, get, remove, rebuild, and health.
- [ ] Recheck canonical scope, state, evidence tier, and deletion state after
  projection search.
- [ ] Test complete projection rebuild from canonical SQLite.

### 11.3 MCP retrieval

- [ ] Implement `provenloop_context`.
- [ ] Implement `provenloop_explain`.
- [ ] Implement deterministic `provenloop_feedback` actions.
- [ ] Enforce repository, workflow, personal, and branch scope.
- [ ] Rank by scope, relevance, trigger, evidence, freshness, utility, and
  contradiction/stale penalties.
- [ ] Enforce the token ceiling after rendering.
- [ ] Return zero to three items and allow an empty result.
- [ ] Deduplicate repeated injection within a session.
- [ ] Fail closed with no context on timeout or backend degradation.

### 11.4 User control and deletion

- [ ] Implement explicit remember, correct, forget, and mute-for-session.
- [ ] Implement `forget <knowledge-or-playbook>`.
- [ ] Implement delete by source/session/episode.
- [ ] Implement purge of database, artifacts, projections, queue, cache,
  evaluations, logs, and tombstones.
- [ ] Block dependent work while deletion is active.
- [ ] Recompute or deactivate dependent Knowledge.
- [ ] Run the deletion propagation gate before reporting success.

### 11.5 M1 gate

- [ ] Evaluate at least 30 Branch Continuation pairs.
- [ ] Repeated Context Token median decreases by at least 30%.
- [ ] TTV median decreases by at least 15%.
- [ ] Retrieval Precision@3 is at least 90%.
- [ ] Wrong Injection is at most 2% for research and at most 1% for stable
  release.
- [ ] Outcome Success falls by no more than two percentage points.
- [ ] Retrieval latency P95 is at most 150 ms.

## 12. M2: evidence-backed correction learning

### 12.1 Correction capture

- [ ] Normalize explicit user corrections into frozen Correction Keys.
- [ ] Record scope, expected behavior, trigger, task family, subsystem, source
  corrections, and verification evidence.
- [ ] Require a verified result before correction-based Knowledge can activate.
- [ ] Record Correction Opportunities before observing their outcomes.

### 12.2 Knowledge lifecycle

- [ ] Aggregate by stable topic key instead of creating permanent duplicates.
- [ ] Implement `candidate`, `active`, `disputed`, `superseded`, and `archived`.
- [ ] Implement explainable Evidence Tiers.
- [ ] Keep model relevance scores separate from lifecycle authority.
- [ ] Prevent candidate, inferred, disputed, stale, deleted, and
  scope-incompatible items from silent injection.
- [ ] Immediately dispute applicable Knowledge when valid counterevidence
  appears.
- [ ] Rebuild current state from append-only feedback and evidence events.

### 12.3 Admission policy

- [ ] Activate only when deterministic evidence and scope rules pass.
- [ ] Never activate from model self-assessment alone.
- [ ] Never broaden repository Knowledge to personal scope automatically.
- [ ] Never use recalled Knowledge as fresh supporting evidence.
- [ ] Preserve applies-when, non-applicability, proof chain, conflicts, and
  supersession.

### 12.4 M2 gate

- [ ] Evaluate at least 20 independent Correction Opportunities before claiming
  a measured percentage improvement.
- [ ] RCR improves by at least 20% relative to baseline.
- [ ] Knowledge provenance completeness is 100%.
- [ ] Evidence Tier label accuracy is at least 95%.
- [ ] Valid direct counterevidence immediately stops automatic injection.
- [ ] Wrong Injection remains at most 2% for research and at most 1% for stable
  release.

## 13. M1 + M2 MVP Go/No-Go

- [ ] Run event/process integrity, Branch Continuation, Correction Recurrence,
  Negative Trigger, and Safety/Recovery suites.
- [ ] Manually inspect the worst cases, not only aggregate scores.
- [ ] Confirm Severe Harm, secret leakage, cross-repository leakage, deletion
  propagation failure, and Unsupported Completion Claims are all zero.
- [ ] Confirm Outcome Success does not regress beyond the allowed threshold.
- [ ] Run Shadow before any limited Canary.
- [ ] Wait for the configured outcome observation window.
- [ ] Publish a Go, Conditional Go, or No-Go report with limitations and a
  rollback target.
- [ ] Do not begin automatic Skill/Playbook work unless cross-session episode
  reconstruction, retrieval precision, repeated-correction reduction,
  isolation, latency, provenance, and deletion are all credible.

## 14. Deferred until after M1 + M2

- [ ] M3 automatic delayed Outcome Linker.
- [ ] M4 Deep Retrospective and Insight Candidates.
- [ ] M5 Playbook generation, sandbox evaluation, approval, Canary, and
  rollback.
- [ ] M6 additional agent adapters and cross-agent deduplication.
- [ ] Memorix backend integration.
- [ ] Web dashboard and generic annotation UI.
- [ ] Team-scoped synchronization.
- [ ] Online fine-tuning or parameter training.

These items must not expand the first implementation batch.

## 15. First executable slice

The first coding slice should prove one complete path before adding more event
types:

```text
fixture Extension event
  -> envelope validation
  -> write-time redaction
  -> atomic durable queue
  -> worker claim
  -> canonical parser
  -> SQLite transaction
  -> Evidence Ledger
  -> deterministic Gate
  -> JSON/Markdown report and stable exit code
```

The slice is complete when:

- [ ] a valid event passes;
- [ ] a malformed event remains visible and fails;
- [ ] a duplicate event is idempotent;
- [ ] a seeded secret is absent from persisted content;
- [ ] a worker crash can recover the item;
- [ ] a completion claim without invocation evidence fails with exit code `1`;
- [ ] the same results are reproducible from a clean checkout.
