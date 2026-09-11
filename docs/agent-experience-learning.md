# Learning from agent investigation and recovery

Status: implementation contract. Validation results are recorded separately.

Development update (2026-09-10, schema 15): research proposals must pass a
retention assessment with exact sources and lasting value. Eligible references
can return original tool excerpts at the captured worktree and revision, labeled
as references with `inferred` evidence. The model's interpretation is not
delivered as verified guidance. Legacy candidates remain review-only. Known
internal work is excluded by source metadata.

ProvenLoop should retain useful findings from an agent's own research and repeated attempts, even when the user never states a correction. This first slice operates inside one captured task. Cross-task pattern discovery and proactive external research remain part of the later retrospective work.

## Sources and outcomes

| Experience | Required source | Initial outcome |
|---|---|---|
| Research finding | A captured agent summary and the captured tool results it cites | A repository-scoped candidate. Source text or a URL alone does not prove project applicability. |
| Self-directed recovery | Failed operation, native failure, changed retry, successful completion, and an agent summary tied to that sequence | A candidate; only a supported, narrow recovery verifier may activate it. |
| Speculation or unsupported summary | Agent prose without relevant captured external evidence | No persistent experience proposal. |
| Recalled guidance repeated by the agent | Existing guidance or a result already assisted by that rule | No independent support for learning the same rule. |

An agent statement remains model-authored evidence. It never becomes a user quotation, confirmation or permission grant. Research sources retain their captured event IDs, exact quoted spans and any URL/version text actually present in the result. Missing publication or retrieval metadata remains unknown. This feature does not issue extra searches, visit cited URLs or expand tool permissions.

## Extraction and qualification

The source discriminator distinguishes user correction, agent research and agent recovery. Existing user-correction records remain readable. Agent proposals require an exact quotation from a captured agent message and one or more exact quotations from captured tool results in the same bounded context. A summary cannot nominate another session's events or use the internal learner as its author.

Processing starts after a captured agent message and its turn completion or idle event. Windows retain at most 32 events, preserve the previous user-turn boundary, and use the existing incremental queue, inference lease, consent, daily budget and cancellation rules. Multiple summaries in one task do not create independent evidence. Window revisions and retries keep the original expiry and attempt budget.

For self-directed recovery, the initial verifiers cover existing MCP invocation constraints and supported repository test-command substitutions. They require the native failed/retried operation identities, complete arguments, matching workspace and version, a causal recovery chain, and a summary after the selected successful result. No user intervention may be silently bridged into a self-directed recovery. Unrelated success, permission refusals, identical retries after an outage, multiple confounded changes, and missing evidence remain unqualified. The summary's explanation is not proof of causality.

A receipt names the actual source role. Qualified guidance is rendered from the
verified predicate, keeping example values and broader model claims out of
operative advice. Research that passes the development source assessment uses
the separate reference mode. Unsupported recovery claims and unassessed research
remain review-only. References do not produce verified-activation notifications.
Counterevidence, scope, deletion, revocation, and review controls apply to all modes.

## Acceptance cases

| ID | Case | Required check |
|---|---|---|
| EXP-01 | Agent reads documentation and summarizes a reusable requirement | Persist a candidate with exact agent/tool quotations; preserve observed source text without inventing metadata. |
| EXP-02 | Agent invents a finding or cites an unseen URL/event | Reject missing, mismatched or untrusted provenance. |
| EXP-03 | Agent repairs an MCP argument itself and then summarizes | Activate only the supported argument predicate; prove a later matching call can retrieve it. |
| EXP-04 | Agent changes a repository test command itself | Native command proof, exact revision and directory remain mandatory. |
| EXP-05 | Several changes or repeated transient failures precede success | Preserve uncertainty; do not certify a unique cause or count retries as independent support. |
| EXP-06 | Summary appears before completion or borrows another task's result | Reject qualification; never fabricate a user correction. |
| EXP-07 | Search result contains instructions to approve or activate knowledge | Treat those instructions as source data; no permission or lifecycle effects. |
| EXP-08 | Agent repeats recalled guidance | Reject circular support and duplicate activation credit. |
| EXP-09 | New session uses a learned recovery rule | Check scope, contract/revision, actual delivery and source explanation separately. |
| EXP-10 | Disable, delete or revoke while extraction is in progress | Stale results and rebuilds cannot restore the rule or its evidence. |
| EXP-11 | Restart, duplicate capture, late evidence or multiple summaries | Durable scheduling, bounded work, original expiry and no duplicate independent support. |
| EXP-12 | Agent merely completes a task or summarizes routine success | Return no proposal when there is no reusable finding grounded in the captured work. |

Run deterministic provenance, state and qualification regressions first. A real provider replay measures whether the model can discover a finding from these sources; substitute outputs prove only the runtime path. Live installed-host reuse and controlled benefit require their own retained evidence.

## Evaluation entry point

```powershell
npm run build
node scripts/evaluate-automatic-learning.mjs prepare --corpus agent --out .provenloop/agent-input
node scripts/evaluate-automatic-learning.mjs run --prepared .provenloop/agent-input --out .provenloop/agent-run --data-root <consented-data-root> --max-requests 12 --max-attempts 1
```

The authored corpus has 12 windows and eight later-task prompts. Reading those prompts does not execute the later tasks. Use [the validation record](agent-experience-validation.md) for measured results and remaining limits.
