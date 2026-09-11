# Agent experience validation, 2026-09-08

The [implementation contract](agent-experience-learning.md) was written before source changes. This record separates model extraction, deterministic runtime replay and live-host acceptance. The existing user-correction path remains covered by regression tests.

## Real provider replay

Copilot CLI 1.0.84-1 processed 12 authored agent-research and recovery windows through the production isolated provider. The model had no tools or plugins and received only synthetic captured excerpts. The run did not change the installed profile or fetch the example URLs.

| Group | Requests | Observed result |
|---|---:|---|
| Research findings | 2 | Two source-backed agent proposals; no qualification receipt |
| Self-directed MCP and test-command recovery | 2 | Two proposals and two narrow recovery receipts |
| Unseen sources, confounded changes, ambiguous retries, quoted activation instructions, recalled guidance, routine success and transient recovery | 7 | No proposal |
| Summary written before the claimed result | 1 | Model output rejected by the source-quotation guard; no stored proposal or receipt |

All 12 requests ran. The final case is a validation rejection, not model abstention, so the evaluator reports `complete: false`. No independent human labels were supplied, and these counts are not a release-quality precision or recall claim.

- Provider: github-copilot, host-default model, copilot-extractor-v5. The resolved model ID was not exposed.
- Frozen runner identity: `agent-snapshot-a2aff4074fe4f651`.
- Runner SHA-256: `a2aff4074fe4f6514176a0c24995fdc79d6cc71fdd8342271ec8f4c3e3fd88bc`.
- Run interval: 2026-09-08 04:14:58 to 04:18:16 UTC.
- Local evidence: `.provenloop/agent-experience-validation/input/`, `run/` and `runtime-replay.json`. These ignored artifacts remain separate from release evidence.

## Replay through the runtime

The valid actual model outputs were replayed through the current coordinator and in-memory canonical SQLite store. Both research findings stayed candidates. Both recovery rules became active with agent-origin receipts. Later matching Context requests received one scoped rule each; unrelated repository requests received none. Explain showed the agent quotation and tool evidence, with no fabricated user quotation.

This replay used the production Context service with a supplied search projection. It verifies qualification, scope, recorded delivery and explanation. It does not show that a live installed agent used the advice or improved its work. The invalid premature-summary output was not replaced with an empty synthetic success.

## Regression coverage

| Cases | Checks | Test source |
|---|---|---|
| EXP-01/02/07/12 | Exact agent/tool quotations, candidate isolation, unknown source rejection, external instructions without authority | [Agent domain tests](../tests/unit/agent-experience-learning.test.ts) |
| EXP-03/05/06/09 | Native MCP recovery, causal linkage, competing changes, premature summaries, later matching and mismatched retrieval | [Agent domain tests](../tests/unit/agent-experience-learning.test.ts) |
| EXP-04/08/09/10 | Native shell proof, task-start recall contamination, actual Context/Explain, dependent deletion | [Shell tests](../tests/unit/agent-shell-learning.test.ts) |
| EXP-08/10/11 | Recalled-ID candidate suppression, restart, duplicate summaries, task budgets, source deletion and origin-preserving Explain | [Lifecycle tests](../tests/unit/agent-learning-lifecycle.test.ts) |
| EXP-01/03/04/05/06 | Authored corpus, retained replay, no research receipts, export of agent provenance | [Evaluation tests](../tests/unit/agent-experience-evaluation.test.ts) |

Source and queue changes add SQLite schema 14. Existing databases require the normal explicit upgrade; an older runtime must not read the new persisted source-role format.

Repository checks: `npm test` passed 763 tests across 73 files; `npm run test:integration` passed 257 tests across 25 files. Lint, tools/project type checks and `git diff --check` passed. Final review also added regressions for missing task boundaries, task-start recalled guidance, and another agent's premature turn completion.

After those final guards, the 71 relevant storage, Context, reconciliation and deletion integration tests passed again. `npm run package:verify` installed and verified the self-contained tarball (973,990 bytes, 24 files).

## Limits

In the September 8 implementation, research findings remained unverified
candidates, and windows kept at most 32 captured events before the first turn
closure. Long investigations were excluded. The September 11 implementation
selects relevant sources across long tasks and returns eligible findings as
unverified references; see the contract's research-memory section. Missing
user-task boundaries and cross-task retrospective analysis still require later
work. Recall suppression matches known rule IDs; it cannot prove semantic
equivalence of arbitrary paraphrases.

The provider still reports malformed/schema-invalid stdout as a provider failure before the evaluator receives it. Such failures cannot pass acceptance, but their diagnostic category is less precise than failures detected by the source validator. No live installed-host trial, automatic deployment or controlled benefit measurement was performed.

## Research memory regression, 2026-09-11

The new regression uses a 604-event task to verify that an early code read
survives source selection with its original digest. A separate 184-event task
runs through the production provider's input preparation and source validation
with a controlled model response, persists a research finding, reopens SQLite,
rebuilds the search index, and retrieves the finding in a new session at a
different commit within a 600-token Context budget. Explain retains the full
summary and exact supporting quote.

Native event mapping also covers interim tool-request messages, several model
iterations, trailing empty message chunks, subagent closures, and final-message
enrichment. Tool-request messages are marked running; an iteration end cannot
freeze the first interim research summary. Sampled windows omit operation
starts, so an incomplete recovery trace cannot acquire a verification receipt.

The full unit/source-runtime/native-process run passed 1,102 tests with five
existing skips. The integration run passed 273 tests. After the final closure
changes, 129 affected integration tests passed; after the enrichment adjustment,
59 affected unit tests passed. Type checks, lint and the release build passed.
These checks establish the persistence and retrieval path. The controlled model
response does not measure extraction quality on arbitrary real investigations,
and the installed user runtime was not upgraded during this validation.
