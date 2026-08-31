# ProvenLoop

> Turn proven experience into reusable intelligence.

ProvenLoop is a local learning layer for coding agents. It observes real software
work across sessions, connects actions to later outcomes, and turns verified
experience into narrowly scoped knowledge and reusable skills.

It is not another chat client, session viewer, or generic memory database. Its
core job is to answer:

> What did the agent try, what happened afterward, what was actually learned,
> and when should that learning be used again?

## Product promise

As ProvenLoop accumulates evidence:

- developers repeat less project context;
- agents repeat fewer known mistakes;
- user corrections and failed retries decrease;
- useful workflows become reusable without silently changing behavior;
- every learned rule remains explainable, reversible, and bounded in scope.

## Learning loop

```mermaid
flowchart LR
    A[Sessions and tool events] --> B[Work Episodes]
    C[Git, PR, review and CI] --> B
    B --> D[Outcome Linker]
    D --> E[Knowledge Candidates]
    E --> F[Qualified Knowledge]
    F --> G[Task-conditioned retrieval]
    G --> H[Coding Agent]
    H --> A

    F --> I[Skill Candidate]
    I --> J[Replay and baseline evaluation]
    J --> K[Human approval]
    K --> L[Versioned Skill]
    L --> G
```

The default product of learning is a **Knowledge Card**. A **Skill** is a rare,
versioned artifact promoted only after repeated evidence and evaluation.

## Initial integration

The first supported agent is GitHub Copilot CLI. The proposed plugin shape,
pending the F0 Extension gate, contains:

- a session event extension that feeds an asynchronous local queue;
- a local MCP server for scoped context retrieval and feedback;
- a background worker that builds episodes and links outcomes;
- a small runtime instruction that asks Copilot to retrieve relevant context.

Users continue launching Copilot normally. ProvenLoop must not require a wrapper
command or an additional model API key for ordinary use.

## Repository structure

```text
ProvenLoop/
  README.md
  package.json
  packages/
    contracts/
    domain/
    platform-windows/
    storage-sqlite/
    evaluation/
    copilot-adapter/
    host/
    cli/
    testkit/
  tests/
    unit/
    integration/
  spikes/
    f0/
  docs/
    product-design.md
    product-validation.md
    architecture.md
    copilot-event-capture-design.md
    roadmap.md
    implementation-checklist.md
    research/
      competitive-analysis.md
      self-improving-agents.md
```

## Development

The workspace requires Node.js 22.18 and npm 11.

```powershell
npm ci
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run build
```

Run a built-in evaluation fixture:

```powershell
npm run build
.\node_modules\.bin\provenloop.cmd eval run `
  --suite valid-supported-event `
  --out .provenloop\eval
```

Negative fixtures return the product gate exit code instead of converting the
failure into an infrastructure error:

```powershell
.\node_modules\.bin\provenloop.cmd eval run `
  --suite false-completion `
  --out .provenloop\eval
```

Regenerate the Markdown view from a run's stable JSON report:

```powershell
.\node_modules\.bin\provenloop.cmd eval report --run <run-id-or-directory>
```

## Canonical documents

- [Product design](docs/product-design.md)
- [Product validation and quality evaluation](docs/product-validation.md)
- [Technical architecture](docs/architecture.md)
- [Copilot event capture design](docs/copilot-event-capture-design.md)
- [Implementation roadmap](docs/roadmap.md)
- [Executable implementation checklist](docs/implementation-checklist.md)
- [Competitive and Copilot investigation](docs/research/competitive-analysis.md)
- [Self-improving agent research](docs/research/self-improving-agents.md)

## Current product decisions

- Local-first and private by default.
- GitHub Copilot CLI first; adapters may support other coding agents later.
- Work Episode, not Session, is the unit of learning.
- External outcomes outrank model self-assessment.
- Context retrieval has a hard token budget.
- Knowledge is scoped to personal, workflow, repository, or branch context.
- Skill candidates are never enabled automatically in the MVP.
- Every memory and skill has evidence, lifecycle, version, and rollback.
- ProvenLoop owns engineering evidence and evaluation data.
- Generic memory/search is accessed through a replaceable `KnowledgeBackend`.

## Status

The local TypeScript/Node.js MVP is under implementation. Shared contracts and
the evaluation spine are complete. Batch 3 now includes deterministic capture
envelopes, write-time redaction, the Windows durable queue, supported Copilot
event mapping, bounded buffering, asynchronous persistence, and explicit
capture-gap reporting. Recovery now streams supported Copilot Session files,
rejects unknown versions explicitly, and replays only source events absent from
both the queue and canonical watermark. Batch 4 adds the transactional
canonical SQLite store and a leased, bounded worker that commits before queue
acknowledgement. The worker now has resource-pressure admission, SQLite
upgrade/backup/restore validation, and an end-to-end canonical Ledger Gate.
Batch 5 now adds the shared `AgentAdapter` lifecycle contract and operational
CLI commands for install, status, doctor, capability enable/disable, and
uninstall. The Copilot adapter generates and registers a local marketplace with
the capture Extension and MCP process, preserves JSONC user settings, resolves
Git and Session identity, reports incompatible Copilot versions explicitly,
and preserves local data unless uninstall is combined with `--purge`.
The shared worker can now be enabled independently and drained on demand with
`provenloop worker run`; each batch rechecks persisted capability state and
writes a health heartbeat.
M1 now starts with a rebuildable Branch Context projection. Material changes
produce short-lived repo/branch/HEAD-bound context, while browsing-only
Sessions produce no context and stale or mismatched HEADs fail closed.
The `@provenloop/retrieval` package now defines the backend-neutral Knowledge
boundary and a SQLite FTS5/BM25 implementation. Search hits are always
rechecked against canonical lifecycle, evidence tier, scope, expiry, and
deletion state before retrieval.
Batch 6 has started with a deterministic Work Episode builder. It groups
canonical Session evidence repository-first, retains low-confidence links as
candidates, applies explicit merge/split corrections, avoids bridge merges with
complete-link clustering, and atomically rebuilds explainable Episode and
association projections in SQLite. Canonical Git parent metadata now feeds a
repository-scoped ancestry graph, and `provenloop eval episodes` runs the
versioned 24-pair quality dataset with distinct precision, recall, wrong-merge,
wrong-split, candidate, and ambiguous-case metrics.
The M0 release gate is now executable through
`provenloop eval m0 --out <directory>`. It retains all suite reports and
Ledgers, the Episode dataset result, code provenance, and known blockers.
`provenloop delete` now removes source, Session, or Episode evidence across the
canonical store and durable queue, rebuilds dependent Episode projections, and
reports success only after persisted deletion-propagation evidence passes.
Current M0 output is intentionally `blocked` until the remaining Windows
latency, provider-degradation, remote-upgrade, and operational
capability evidence is completed.
