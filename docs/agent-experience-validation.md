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

Research findings remain unverified candidates; external source text does not establish project applicability. The current window keeps one task's last summary before its first closure and at most 32 captured events. Long investigations, missing user-task boundaries and cross-task retrospective analysis require later work. Recall suppression matches known rule IDs; it cannot prove semantic equivalence of arbitrary paraphrases.

The provider still reports malformed/schema-invalid stdout as a provider failure before the evaluator receives it. Such failures cannot pass acceptance, but their diagnostic category is less precise than failures detected by the source validator. No live installed-host trial, automatic deployment or controlled benefit measurement was performed.
