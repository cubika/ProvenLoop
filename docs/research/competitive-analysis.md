# ProvenLoop research findings

> This document records the technical, product, and competitive research conducted before and after ProvenLoop's product definition.
> See the [product design](../product-design.md) for the complete specification.

**Research snapshot:** 2026-08-20
**Initial environment:** Windows + `agency copilot` + GitHub Copilot CLI

## 1. Summary of findings

The original idea was local Coding Agent Memory that works unobtrusively across Sessions:

```text
Install once
  -> Users continue using Copilot normally
  -> Observe Sessions automatically
  -> Retain personal habits and engineering lessons
  -> Use them automatically in later related tasks
  -> Reduce repeated explanations and mistakes over time
```

The research calls for revising this positioning.

Many existing solutions already provide:

- Coding Agent Session capture.
- Background summarization and compression.
- MCP retrieval and injection.
- Short-term and long-term memory layers.
- Conversion of Git Commits into engineering memory.
- Semantic, Episodic, Procedural Memory.
- Outcome Signals such as user corrections and test success or failure.
- Shared memory across Agents such as Claude Code, Codex, and Copilot.
- Synchronization of stable rules to files such as `AGENTS.md` and `CLAUDE.md`.

ProvenLoop should therefore move beyond the positioning:

> Local-first coding-agent memory.

A more accurate positioning is:

> **ProvenLoop is a learning layer for Coding Agents that uses feedback from software outcomes. It connects Sessions, Commits, PRs, Reviews, CI, tests, and later Bug Fixes into work traces, then uses later outcomes to revise earlier Agent decisions.**

Recommended technical strategy:

```text
Build the differentiating layer
Integrate the commodity memory layer
```

In practice:

- Use Memorix for general-purpose Memory, MCP, Hooks, Git Memory, retrieval, and lifecycle management.
- Build ProvenLoop's own Work Episode, Outcome Linker, causal retrospectives across time, and effectiveness evaluation.
- Extend through composition using Memorix's npm SDK and embedded MCP Server capabilities without forking Memorix.
- Require no additional API Key; use the user's existing sign-in with `agency copilot -p` for background analysis.
- Keep the user's launch command unchanged: `agency copilot`.

---

## 2. Native GitHub Copilot CLI capabilities

### 2.1 Session history

Copilot CLI records:

- User Prompts.
- Assistant responses.
- Tool calls and results.
- Modified files.
- Tokens, models, and duration.
- Structured data such as Checkpoints and Session references.

Local locations:

```text
~/.copilot/session-state/<session-id>/
~/.copilot/session-store.db
```

Each Session directory typically contains:

```text
events.jsonl
workspace.yaml
checkpoints/
files/
```

`events.jsonl` is the full event stream and may contain:

```text
user.message
assistant.message
tool.execution_start
tool.execution_complete
session.mode_changed
```

`session-store.db` is a SQLite index containing:

```text
sessions
turns
session_files
session_refs
assistant_usage_events
checkpoints
search_index
```

Session data and Copilot Memory are separate systems.

### 2.2 Measurements on this machine

Inspection results from this machine on 2026-08-17:

| Data | Count |
|---|---:|
| Sessions in the database | 90 |
| Local Session directories | 81 |
| Present in both the database and directories | 74 |
| Present only in the database | 16 |
| Present only as directories, not yet indexed | 7 |
| Conversation Turns | 524 |
| File operation records | 853 |
| Model Usage records | 9,431 |
| Agent trajectory events | 10,312 |

History range:

```text
Earliest: 2026-03-19 05:24 UTC+8
Latest: 2026-08-17
```

Storage size:

```text
session-store.db: about 18 MiB
session-state: about 3.59 GiB
```

GitHub documentation does not state a fixed automatic expiration period for Session history. It is usually retained until the user deletes it. Copilot Memory's 28-day rule does not apply to Session history.

### 2.3 Chronicle

Copilot CLI already provides:

```text
/chronicle search
/chronicle standup
/chronicle tips
/chronicle cost tips
/chronicle improve
/chronicle reindex
```

Chronicle can search history, analyze Tokens, and generate suggestions, but it is not a programmable engineering-feedback learning system.

### 2.4 Very long Sessions

Copilot automatically Compacts when Context approaches roughly 95% and also supports:

```text
/compact
/context
/usage
```

ProvenLoop should avoid rereading or resending entire long Sessions. Instead:

```text
Read events.jsonl incrementally
  -> Split by Prompt or task
  -> Extract structured signals
  -> Save references and summaries
  -> Read local evidence excerpts only when needed
```

### 2.5 Hooks

Copilot CLI supports user-level Hooks:

```text
~/.copilot/hooks/*.json
```

Important events:

```text
sessionStart
sessionEnd
userPromptSubmitted
userPromptTransformed
preToolUse
postToolUse
postToolUseFailure
agentStop
preCompact
errorOccurred
```

Capabilities:

- `sessionStart` can inject `additionalContext`.
- `postToolUse` can append Context or modify tool results.
- `sessionEnd` can trigger background processing.
- Configuration-file Hooks for `userPromptSubmitted` cannot directly modify the Prompt.
- `userPromptTransformed` can modify the Prompt seen by the model, but is not suitable as a general-purpose Memory API.

Hooks must remain fast. ProvenLoop uses:

```text
sessionEnd Hook
  -> Write to a persistent queue
  -> Wake the Worker
  -> Return immediately
```

This avoids synchronously waiting for a retrospective when the Session ends.

### 2.6 OpenTelemetry

Copilot CLI natively supports OpenTelemetry, disabled by default.

It can observe:

- Agent invocation.
- LLM calls.
- Tool calls.
- Token.
- Duration and errors.
- Sub-Agent Traces.

Example:

```powershell
$env:COPILOT_OTEL_FILE_EXPORTER_PATH="$HOME\.copilot\copilot-otel.jsonl"
copilot
```

This is useful for Observability, but is not ProvenLoop's core data model. Session events, Git, and GitHub lifecycle data are more suitable as learning evidence.

---

## 3. GitHub Copilot Memory

### 3.1 What it stores

Copilot Memory stores two categories:

#### Repository-level facts

- Coding conventions.
- Architecture decisions.
- Build and test commands.
- Project rules.

#### User-level preferences

- Interaction style.
- Personal coding habits.
- Workflow preferences.

### 3.2 Approximate implementation

Public information suggests a workflow resembling:

```text
Copilot interaction
  -> Extract candidate facts or preferences
  -> Store within user or repository scope
  -> Retrieve relevant items for a new task
  -> Verify that they still hold
  -> Inject into current Agent Context
```

Repository fact:

- Stores code references supporting the fact.
- Revalidates against the current Branch before use.
- Used only within the same repository.

User preference:

- May cite the user's exact words.
- Bound to the current user and billing entity.
- May be used across repositories.

Unused Memory is automatically deleted after 28 days; successful validation and use may reset the timer.

### 3.3 Differences from ProvenLoop

| Dimension | Copilot Memory | ProvenLoop |
|---|---|---|
| Main content | Facts and preferences | Work processes, outcomes, and lessons |
| Learning unit | Individual Memory item | Work Episode |
| Engineering data | Code references | Session, Commit, PR, Review, CI, Bug Fix |
| Short-term development Context | Not specifically bound to Branch | Branch Context |
| Retrospective analysis of later Bugs | Not a core capability | Core differentiator |
| Effectiveness metrics | Not public | Correction counts, retries, first-attempt success rate |
| Storage | Hosted by GitHub | Local and auditable |
| Agent coverage | GitHub Copilot | General-purpose Core + multiple Agent Adapters |

If ProvenLoop only stores preferences and repository facts, Copilot Memory already covers that scope.

---

## 4. Session Viewer and Observability tools

Existing tools for Copilot CLI include:

### TracePilot

<https://github.com/MattShelton04/TracePilot>

- Windows Tauri desktop application.
- Sessions, conversations, tool calls, Todos, and Checkpoints.
- Tokens, costs, Timeline, and Waterfall.
- Search, analysis, and Session Orchestration.

### gh-agent-viz

<https://github.com/maxbeizer/gh-agent-viz>

- GitHub CLI TUI.
- Local and remote Agent Sessions.
- Tool Timeline, Telemetry, Diff, Resume.

### copilot-session-tools

<https://github.com/Arithmomaniac/copilot-session-tools>

- Web UI and CLI.
- Reads Chronicle.
- Expands tool calls, Diffs, and Thinking Blocks.

### copilot-replay

<https://github.com/Lukasedv/copilot-replay>

- Replays `events.jsonl`.
- Intended for demonstrations and event-by-event browsing.

Conclusion:

> Do not build another ordinary Session Viewer. Tools for inspecting what happened already exist.

---

## 5. Third-party LLM Memory solutions

### 5.1 Mem0

<https://github.com/mem0ai/mem0>

Positioning:

- General-purpose Memory SDK/API for AI application developers.

Capabilities:

- Extracts facts from conversations.
- User, Agent, and Run scopes.
- Vector, BM25, and Entity retrieval.
- Deduplication and long-term preferences.

Gaps:

- Does not understand Git, PRs, Reviews, tests, and later Bugs.
- No Work Episode.
- Does not measure improvement in engineering outcomes.

Useful ideas to adopt:

- Append-only evidence.
- Scope model.
- Hybrid retrieval.
- History and Audit.

### 5.2 Zep / Graphiti

<https://github.com/getzep/graphiti>

Graphiti is a temporal Knowledge Graph:

- Episode.
- Entity.
- Fact provenance.
- `valid_at`, `invalid_at`, `expired_at`.
- Semantic, BM25, and Graph traversal.

Most relevant to ProvenLoop:

- Distinguishes event time from system observation time.
- Does not overwrite original Evidence.
- New evidence can invalidate old conclusions.
- Saga can inform the Work Episode design.

Unsuitable as the MVP's default dependency:

- Requires a graph database.
- Deployment and maintenance are too heavy.
- ProvenLoop would still need to model the coding lifecycle.

### 5.3 Letta / MemGPT

<https://github.com/letta-ai/letta-code>

Capabilities:

- Core Memory and Archival Memory.
- Stateful Agent.
- Agents actively rewrite memory.
- Git-backed Memory Filesystem.
- Background Dreaming.

Differences:

- Letta is a complete Agent Runtime.
- ProvenLoop is a learning layer attached to existing Coding Agents.

Useful ideas to adopt:

- Reasons and version history for Memory changes.
- Separate Working and Archival Memory layers.
- Background Reflection.

### 5.4 LangMem / LangGraph Memory

<https://github.com/langchain-ai/langmem>

Explicitly distinguishes:

```text
Semantic Memory
Episodic Memory
Procedural Memory
```

Supports:

- Immediate writes by the Agent.
- Background Manager.
- Prompt optimization driven by Trajectory + Feedback.

Gaps:

- No Session, Git, or PR Collectors.
- No Coding Work Episode.
- A development framework, not a ready-to-use product.

### 5.5 Cognee

<https://github.com/topoteretes/cognee>

Capabilities:

- Graph + Vector Memory.
- Coding Agent Plugin.
- Recall before the Prompt.
- Tool Trace Capture.
- Synchronization to long-term Memory after Session End.

Its Hooks, Worker, and per-Prompt retrieval closely overlap with ProvenLoop's operating model.

Gaps:

- No explicit causal retrospective across the software lifecycle.
- Does not use Markdown as the long-term source of truth.
- Focuses on Recall rather than learning from outcomes.

### 5.6 Supermemory

<https://github.com/supermemoryai/supermemory>

Capabilities:

- User Profile.
- Temporal Fact.
- Contradiction and Expiry.
- Agent Plugin and MCP.

Gaps:

- The public repository does not allow complete verification of the core engine.
- No engineering causal chain across PR, Review, CI, and Bug Fix.

### 5.7 Claude-Mem

<https://github.com/thedotmack/claude-mem>

This solution is closest to ProvenLoop in its operating model:

- Lifecycle Hooks.
- Background Worker.
- SQLite.
- Chroma Semantic Search.
- Session Summary.
- MCP Progressive Disclosure.

It mainly answers:

> What was done before?

ProvenLoop should answer:

> Why did the earlier implementation miss this issue? What later evidence established it? How can it be avoided next time?

### 5.8 Basic Memory

<https://github.com/basicmachines-co/basic-memory>

Uses:

- Markdown as the Source of Truth.
- SQLite as a rebuildable index.
- MCP reads and writes.
- Humans and AI can edit the same knowledge.

This supports ProvenLoop's Markdown + SQLite design, but the design itself is not a differentiator.

---

## 6. Detailed Memorix evaluation

Project:

<https://github.com/AVIDS2/memorix>

State at the time of research:

```text
Version: 1.7.2
License: Apache-2.0
Stars: about 665
Forks: about 53
Main language: TypeScript
Node: >= 22.18
```

The project is very active, but most commits come from one maintainer. The public release notes at the time report about 2,900 tests, covering Windows, macOS, Ubuntu, and large-dataset validation.

### 6.1 Agent integrations

Memorix already supports:

- GitHub Copilot CLI.
- Claude Code.
- Codex.
- Cursor.
- Windsurf.
- Gemini CLI.
- OpenCode.
- Kiro.
- Other Coding Agents.

The Copilot Plugin includes:

```text
MCP
Skills
Hooks
```

The Copilot Hook already listens for:

```text
sessionStart
sessionEnd
userPromptSubmitted
postToolUse
preCompact
```

Installation:

```text
memorix setup --agent copilot --global
```

### 6.2 Memory Layers

#### Observation Memory

Supports:

```text
session-request
gotcha
problem-solution
how-it-works
what-changed
discovery
why-it-exists
decision
trade-off
reasoning
```

#### Reasoning Memory

Stores:

- Reasons for decisions.
- Alternatives.
- Constraints.
- Risks and Trade-offs.

#### Git Memory

Commits are converted into:

- Commit Hash.
- Changed Files.
- Title and Narrative.
- Inferred Observation Type.
- Concepts and Entities.

Supports Git Hooks and historical backfill.

#### Long-term Memory

Types:

```text
episodic
semantic
procedural
```

Lifecycle:

```text
candidate
  -> qualified
  -> approved
  -> archived / superseded
```

### 6.3 Storage and retrieval

- SQLite is the canonical store.
- Orama handles full-text and hybrid retrieval.
- Embedding can be disabled or use an API or local Provider.
- Supports Token Budget.
- Supports Progressive Disclosure.
- Supports Source-aware Ranking.
- Supports project identity and visibility boundaries.

### 6.4 Memory Formation

Formation Pipeline:

```text
Extract
  -> Resolve
  -> Evaluate
```

Features:

- Extracts atomic facts.
- Normalizes titles.
- Entity Resolution.
- Corrects types.
- Merge, Evolve, Discard.
- Scores long-term value.
- Classifies items as Core, Contextual, or Ephemeral.

### 6.5 Evidence Governor

Memorix already has a fairly mature Memory Quality design:

```text
scope
  -> provenance
  -> freshness
  -> conflict
  -> quality
  -> token budget
```

It can:

- Abstain when no qualified Memory exists.
- Downgrade old Memory after code changes.
- Preserve original Evidence.
- Prevent the model from silently overwriting facts.
- Explain why Memory was included or excluded.

### 6.6 Outcome Signal

Already defined:

```text
verification-passed
verification-failed
verified-reuse
user-pin
user-correction
source-changed
conflict-confirmed
manual-review
```

Failures, corrections, and source-code changes downgrade Memory.

This shows that Outcomes affecting Memory Quality are not, by themselves, a unique ProvenLoop innovation.

### 6.7 Rules and Skills

Memorix can:

- Promote knowledge to a Mini Skill.
- Synchronize rule files across Agents.
- Maintain MCP, Hook, Skill, and Instruction integrations.

ProvenLoop should therefore avoid spending substantial time reimplementing rule-format conversion.

### 6.8 SDK

Public SDK:

```typescript
import {
  createMemoryClient,
  createMemorixServer,
} from "memorix/sdk";
```

`MemoryClient` supports:

```text
store
search
get
getAll
count
resolve
close
```

`createMemorixServer` can register with an existing MCP Server, providing a basis for extension through composition.

### 6.9 Behavior without an API Key

Memorix can operate without an API Key.

Without an API Key, these remain available:

- SQLite storage.
- BM25 full-text retrieval.
- Hooks.
- MCP.
- Git Memory.
- Local rule filtering and deduplication.
- Memory Lifecycle.

Disable Embedding:

```toml
[embedding]
provider = "off"
```

Without `MEMORIX_LLM_API_KEY`:

- LLM Formation is unavailable.
- LLM Summarization is unavailable.
- Intelligent Dedup and Rerank are unavailable.
- The system falls back to local Heuristic mode.

This is acceptable for ProvenLoop because it can use the user's existing Copilot sign-in for background reasoning.

### 6.10 Gaps Memorix does not yet cover

The research did not find a complete Memorix implementation of:

```text
Session
  -> Branch
  -> Commit
  -> PR
  -> Review
  -> CI / Test
  -> Merge
  -> Later Issue / Bug Fix / Revert
```

Nor did it find product-level automation that answers:

> Which Agent PR from weeks ago missed which check and led to this later Bug Fix?

Memorix has Outcome Signals, but these mainly provide quality feedback for individual Memory items or Workflows, not causal analysis across the full software lifecycle.

---

## 7. Why not fork Memorix

Memorix can be extended without a fork.

The recommended architecture uses composition:

```text
ProvenLoop Copilot Plugin
├─ ProvenLoop Hooks
├─ ProvenLoop MCP Tools
├─ Work Episode Builder
├─ Outcome Linker
├─ Retrospective Analyzer
└─ memorix npm dependency
   ├─ Storage
   ├─ Search
   ├─ Git Memory
   ├─ Lifecycle
   └─ Generic MCP Tools
```

Illustrative code:

```typescript
import {
  createMemoryClient,
  createMemorixServer,
} from "memorix/sdk";

const server = new McpServer(...);

// Register Memorix's general-purpose tools.
await createMemorixServer(projectRoot, server);

// Register ProvenLoop's differentiated tools.
registerEpisodeTools(server);
registerOutcomeTools(server);
registerRetrospectiveTools(server);
```

ProvenLoop stores its own domain model:

```text
LifecycleEvent
WorkEpisode
EpisodeLink
OutcomeEvidence
Retrospective
BehaviorMetric
```

Final, stable conclusions are written to Memorix:

```typescript
await memory.store({
  entityName: "auth-rate-limiter",
  type: "problem-solution",
  title: "IPv6 handling was missing",
  narrative: "...",
  relatedCommits: ["abc", "def"],
  topicKey: "retrospective:auth-rate-limiter",
});
```

A fork is needed only if:

- ProvenLoop must modify Memorix's internal Schema.
- The required API cannot be implemented through the SDK or CLI.
- Upstream will not accept a necessary Extension API.
- Runtime performance requirements demand changes to the core execution path.

Order of preference:

```text
Public SDK
  -> Independent ProvenLoop Store
  -> Upstream PR to Memorix
  -> Fork only as a last resort
```

---

## 8. Background reasoning without an additional API Key

The user already uses GitHub Copilot through Agency:

```powershell
agency copilot
```

Agency can forward Prompts and arguments to the underlying Copilot CLI:

```powershell
agency copilot -p "..."
```

ProvenLoop's background Worker can therefore call:

```powershell
$env:PROVENLOOP_INTERNAL = "1"
agency copilot -p "Analyze this Session, Commit, PR, Review, and test evidence and produce a structured retrospective"
```

Characteristics:

- No OpenAI, Anthropic, or Memorix API Key required.
- Reuses the user's existing GitHub Copilot sign-in and subscription.
- Uses the user's existing Agency Copilot model capabilities.
- Background analysis runs in a separate Copilot Session.
- The user's current foreground Session does not wait.

`PROVENLOOP_INTERNAL=1` tells Hooks to skip internal analysis Sessions and prevent recursion:

```text
Analysis Session
  -> Hook triggers analysis again
  -> Infinite loop
```

The background Worker should still:

- Use a persistent queue.
- Ensure that only one Worker runs at a time.
- Exit when the task completes.
- Resume processing the backlog after a machine restart.
- Avoid AI calls for Sessions with no learning value.

---

## 9. Launch compatibility with `agency copilot`

The user's current launch command:

```powershell
agency copilot
```

Agency's `copilot` command runs the underlying GitHub Copilot CLI and supports:

- Copilot Plugin.
- `~/.copilot` configuration.
- MCP.
- Agent.
- Forwarding native Copilot arguments.

ProvenLoop's global Plugin installation location:

```text
~/.copilot/plugins/local/provenloop/
```

After installation, users still run:

```powershell
agency copilot
```

They do not need:

```text
provenloop copilot
memorix copilot
A special Wrapper
```

Normal invocation loads the Plugin automatically.

Caveats:

- `agency copilot --profile-only ...` ignores environment configuration and Plugins not declared in the Profile.
- `--no-config-plugins` disables automatic Plugins in Agency configuration.
- Users of these special flags must explicitly declare ProvenLoop in their Profile.

Ordinary `agency copilot` invocation is unaffected.

---

## 10. Latest recommended architecture

```text
                    agency copilot
                           |
                           v
                GitHub Copilot CLI
                           |
            +--------------+--------------+
            |                             |
            v                             v
      ProvenLoop Hooks               ProvenLoop MCP
            |                             |
            v                             v
    Persistent Event Queue       Per-Prompt Context Query
            |                             |
            v                             |
   On-demand Shared Worker                |
            |                             |
    +-------+------------------+          |
    |                          |          |
    v                          v          |
Lifecycle Collectors    Retrospective AI  |
Session / Git / GitHub   agency copilot -p|
    |                          |          |
    +------------+-------------+----------+
                 |
                 v
        ProvenLoop Domain Store
      Work Episode / Outcomes / Metrics
                 |
                 v
             Memorix SDK
      Generic Memory / Search / Lifecycle
```

### Memorix responsibilities

- Project identity.
- General-purpose Observation.
- Reasoning and Git Memory.
- SQLite storage.
- BM25 and optional Semantic Search.
- Memory Lifecycle.
- Evidence Qualification.
- General-purpose MCP tools.
- Rule and Skill synchronization.
- Foundations for multiple Agent integrations.

### ProvenLoop responsibilities

- Copilot Session and GitHub lifecycle Collectors.
- Relationships among Branch, Commit, PR, Review, CI, Issue, and Fix.
- Work Episode Builder.
- Outcome Linker.
- Causal retrospectives across time.
- Correction and retry metrics.
- Branch Context.
- Episode-aware Retrieval for new tasks.

---

## 11. Revised MVP

### P0: Differentiated capabilities

1. **Unified lifecycle event model**

```text
session
prompt
tool
branch
commit
pull-request
review
test
ci
issue
fix
revert
correction
```

2. **Work Episode Builder**

Association signals:

- Repo ID.
- Branch.
- Commit ancestry.
- PR and Issue references.
- Overlap in modified files.
- Time.
- Prompt semantics.
- Test names and errors.

3. **Outcome Linker**

Detect:

- Later test failures.
- Review Correction.
- Revert.
- Fix Commit.
- User corrections.

Then identify older Episodes that may need reassessment.

4. **Retrospective Analyzer**

Structured output:

```text
earlier assumption
missing check or invariant
later evidence
generalized lesson
applicability
counterevidence
confidence
```

5. **Behavior Metrics**

Primary metric:

```text
Fewer user corrections in similar tasks
```

Supporting metrics:

- Tool and test retries.
- Repeated Context input.
- CI or Review passing on the first attempt.
- Frequency of failures caused by incorrect Memory.

### P1: Essential user experience

- One-click Copilot Plugin installation.
- Nonblocking Hooks and a persistent queue.
- Branch Context.
- Per-Prompt MCP retrieval.
- Explain and Forget.

### Areas that should not receive major in-house investment

- General-purpose Memory CRUD.
- General-purpose vector databases.
- General-purpose Embedding Providers.
- General-purpose Rules conversion.
- Ordinary Session Viewer.
- Ordinary Dashboard.
- General-purpose Agent Orchestration.

---

## 12. Build vs Integrate decision

### Integrate Memorix

Use:

- npm package.
- `memorix/sdk`.
- `createMemoryClient`.
- `createMemorixServer`.
- Memorix Observation and Git Memory.

### Implement independently in ProvenLoop

Build:

- Lifecycle Store.
- Work Episode Store.
- Outcome Evidence.
- Retrospective Card.
- Effect Evaluation.

### Do not adopt immediately

- Graphiti as the default backend: too heavy.
- Mem0 as the Canonical Store: its model does not fit engineering Evidence.
- Custom general-purpose vector search: no differentiation.
- A deep Memorix fork: high maintenance cost and risk of divergence from upstream.

---

## 13. Main risks

### Memorix evolves too quickly

Risks:

- The SDK does not yet cover all internal capabilities.
- Maintenance is concentrated among very few people.
- Schema and API may change rapidly.

Mitigation:

- Depend only on the public `memorix/sdk`.
- Pin a compatible version.
- Store ProvenLoop domain data separately.
- Add an Adapter layer.
- Prefer upstream contributions for required capabilities.

### Memorix uses SQLite as its Canonical Store

This differs from the original design in which Markdown was the source of all facts.

Recommended adjustments:

- Memorix stores general-purpose Observations and retrieval records.
- ProvenLoop's final Retrospective Cards may remain in Markdown.
- ProvenLoop indexes Markdown conclusions in Memorix.
- Do not require all internal Memorix data to be converted to Markdown.

### Recursive background Copilot calls

Mitigation:

- `PROVENLOOP_INTERNAL=1`.
- Hooks detect and skip them.
- Mark the provenance of internal Sessions.

### Incorrect automatic causal attribution

Mitigation:

- Associate using multiple signals.
- Every conclusion must cite specific Evidence.
- Do not automatically inject low-confidence conclusions.
- Pause old conclusions immediately when new conflicts appear.

### Plugin fails to load

Mitigation:

- `provenloop doctor`.
- Check the `agency copilot` Profile.
- Check Plugin, MCP, and Hook status.
- Start a new Session after installation to verify loading.

---

## 14. Final assessment

### Extending Memorix is feasible

It is also more sensible than building all the infrastructure from scratch.

But ProvenLoop cannot be only:

```text
Memorix + Copilot Adapter
```

Memorix already has a Copilot Adapter.

ProvenLoop must focus on:

```text
Complete software lifecycle events
  -> Work Episode
  -> Later Outcomes
  -> Retrospective causal analysis
  -> Verifiable engineering lessons
  -> Fewer corrections next time
```

### Recommended product relationship

```text
Memorix
  = General-purpose Coding Agent Memory Platform

ProvenLoop
  = Outcome-aware Engineering Learning Engine
```

### Recommended user experience

Conceptual installation:

```powershell
provenloop install
```

The installer handles:

- Installing the ProvenLoop Copilot Plugin.
- Installing or bundling the Memorix Dependency.
- Registering Hooks.
- Registering MCP.
- Setting up the Worker.
- Scanning the last 30 days of history to establish a long-term baseline.

Afterward, users always run:

```powershell
agency copilot
```

No additional API Key, change to the launch command, or manual learning trigger is required.

---

## 15. Main references

### GitHub Copilot

- <https://docs.github.com/en/copilot/concepts/agents/copilot-memory>
- <https://docs.github.com/en/copilot/concepts/agents/copilot-cli/chronicle>
- <https://docs.github.com/en/copilot/reference/hooks-reference>

### Memorix

- <https://github.com/AVIDS2/memorix>
- <https://github.com/AVIDS2/memorix/blob/main/docs/ARCHITECTURE.md>
- <https://github.com/AVIDS2/memorix/blob/main/docs/GIT_MEMORY.md>
- <https://github.com/AVIDS2/memorix/blob/main/docs/MEMORY_FORMATION_PIPELINE.md>
- <https://github.com/AVIDS2/memorix/blob/main/docs/1.4.2-EVIDENCE-GOVERNED-MEMORY-SPEC.md>
- <https://github.com/AVIDS2/memorix/blob/main/src/sdk.ts>
- <https://github.com/AVIDS2/memorix/blob/main/src/knowledge/outcome-types.ts>

### Other Memory solutions

- <https://github.com/mem0ai/mem0>
- <https://github.com/getzep/graphiti>
- <https://github.com/letta-ai/letta-code>
- <https://github.com/langchain-ai/langmem>
- <https://github.com/topoteretes/cognee>
- <https://github.com/supermemoryai/supermemory>
- <https://github.com/thedotmack/claude-mem>
- <https://github.com/basicmachines-co/basic-memory>

### Copilot Session tools

- <https://github.com/MattShelton04/TracePilot>
- <https://github.com/maxbeizer/gh-agent-viz>
- <https://github.com/Arithmomaniac/copilot-session-tools>
- <https://github.com/Lukasedv/copilot-replay>
