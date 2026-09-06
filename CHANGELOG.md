# Changelog

All notable changes to ProvenLoop are documented here.

## [0.1.0-alpha.0.9] - 2026-09-06

Windows Design Partner Preview evidence candidate. Includes the full capability
scope recorded under the attempted 0.8 release below, plus deterministic worker
validation. M0/MVP remain No-Go; controlled benefit is unproved and
`0.1.0-alpha.1` remains an unapproved quality-release target.

### Fixed

- Distinguish explicit resource-pressure or circuit pauses from errors in
  package smoke, retain both stdout and stderr diagnostics, and require the
  installed runtime worker to complete under controlled test admission.
- Control resource admission in the current-session reconciliation fixture so
  ambient runner load does not prevent its expected worker rows. Product
  admission thresholds and runtime budgets remain unchanged.
- Supersede the failed 0.8 publication attempt without changing its immutable
  tag. The earlier smoke treated a potentially legitimate resource pause as a
  failure; surfaced diagnostics did not establish the exact worker reason.

### Validation boundary

The 0.8 release lint, typecheck, unit, and integration jobs passed, but package
smoke stopped publication before any GitHub Release or assets were created.
These results do not certify the new 0.9 artifacts; new-version validation and
publication must be verified separately.

## [0.1.0-alpha.0.8] - 2026-09-06

**Failed publication attempt — no GitHub Release or assets; superseded by
`0.1.0-alpha.0.9`.** The tag at `b40d03e` remains immutable. The following is
the attempted capability scope, not a successfully published package.

Windows Design Partner Preview evidence candidate, not an M0/MVP-approved
quality release. Controlled field benefit remains unestablished, and
`0.1.0-alpha.1` remains an unapproved target.

### Added

- Explicit Knowledge review, confirmation, replacement, and revocation, with
  reviewed digests and separately acknowledged counterevidence.
- Local observation summaries and privacy-bounded exports that distinguish
  provided context, user-reported adoption, and unknown outcomes.
- Task-start context instructions and live SDK workspace identity shared by
  capture, MCP, and workflow-scoped Knowledge controls.
- Native SDK causal verification bridge and `assistant.turn_start` mapping.
- Bounded current-session reconciliation in the installed Extension background
  loop, using matched SDK identity/workspace, a join-time lower bound, and
  state/path/lease checks. Worker/admission runs first, then reconciliation and
  observations every 30 seconds, with two-second catch-up on progress or budget
  exhaustion; runtime shutdown stops the loop.

### Fixed

- Bind correction verification to the actual tool operation and source
  workspace; prevent older confirmations from erasing newer counterevidence.
- Require trusted live SDK context, cross-process reader-probe guards, and
  explicit real-user confirmation for persistent MCP feedback. Workflow
  Knowledge controls require matching live `SESSION_ID`, workflow, and cwd.
- Preserve bounded capture metadata and reconcile incomplete session events
  with two-pass redaction and append-only enrichment, without overwriting
  original evidence or resurrecting deleted sources.
- Isolate corrupt queue items and prune acknowledged items without deleting
  pending work. Guard deletion/projection transactions and restore tombstones.
- Require explicit schema-10 maintenance migration with verified pre-upgrade
  snapshots and guarded recovery rather than silently downgrading data.
- Retrieve ordinary English and Chinese queries without allowing short
  queries to spuriously match more specific exclusion conditions.
- Bound test-runner process contention without relaxing runtime deadlines.

### Known limitations

- Missing or mismatched SDK workspace metadata produces a diagnostic and skips
  automatic backfill. Capture is best effort, not lossless or full-history ingestion.
- M0 platform, latency, provider-degradation, and remote-upgrade evidence remains
  open. MVP remains No-Go; synthetic fixtures and local observations cannot clear
  the blocked controlled-field-effect gate.
- Distribution uses GitHub Release tarball/checksum assets, with npm only as the
  local installer; this candidate is not being published to the public npm registry.
- Prior source validation is not validation of the new versioned artifacts.

## [0.1.0-alpha.0.7] - 2026-09-05

### Fixed

- Make Windows-hosted integration tests independent of current machine resource
  pressure and give bounded asynchronous evaluation work its full test budget.

## [0.1.0-alpha.0.6] - 2026-09-05

### Fixed

- Stage each installer release in a versioned runtime slot, verify that exact
  command, and switch PATH only after the Copilot integration upgrade succeeds.
- Restore the prior plugin registration if marketplace or plugin replacement
  fails, and preserve the previous runtime locator.
- Refuse purge until active Extensions confirm shutdown, and validate managed
  Copilot settings before destructive uninstall work begins.
- Bound Copilot commands and local operation leases so blocked commands return
  actionable errors instead of waiting indefinitely.

## [0.1.0-alpha.0.5] - 2026-09-05

### Fixed

- Raised unit-test and hook timeouts to 30 seconds so the release workflow
  remains reliable on loaded Windows hosted runners.

## [0.1.0-alpha.0.4] - 2026-09-05

### Changed

- Replaced the exact Copilot CLI `1.0.82-0` allowlist with `>=1.0.71`
  and no artificial upper bound.
- The installer now probes the required Plugin Marketplace, installation, and
  plugin enable/disable commands before modifying Copilot configuration.
- Doctor distinguishes verified CLI versions (`1.0.82-0`, `1.0.83-4`) from
  compatible versions that still require ProvenLoop evidence.

## [0.1.0-alpha.0.3] - 2026-09-04

### Added

- Immutable, checksum-verifying PowerShell installer for the Microsoft Design
  Partner preview.
- Stable per-user runtime prefix and PATH command registration.

### Changed

- Lowered the Node.js runtime minimum from 22.18 to 22.16 after running the
  unit and integration suites with Node.js 22.16.
- Installation now probes the required `node:sqlite` APIs directly.

## [0.1.0-alpha.0.2] - 2026-09-03

### Fixed

- Use Windows PowerShell 5.1-compatible absolute path validation for MCP
  launchers on non-C: drives and hosted runners.

## [0.1.0-alpha.0.1] - 2026-09-03

### Fixed

- Read the pinned marketplace ref from Copilot settings instead of relying on
  the abbreviated marketplace list output.
- Increased hosted-runner integration test timeouts without weakening product
  time budgets.
- Superseded by `0.1.0-alpha.0.2` because the MCP launcher rejected some
  valid absolute paths on non-C: drives.

## [0.1.0-alpha.0] - 2026-09-02

### Added

- Self-contained Windows package for `@provenloop/cli`.
- Official GitHub Copilot CLI marketplace and bundled Extension runtime.
- Install, upgrade, status, Doctor, capability control, worker, uninstall, and
  purge lifecycle commands.
- M0, M1, M2, and aggregate MVP release gates.
- Version-bound M0 acceptance evidence and daily acceptance reporting.
- Passive Doctor and opt-in bounded online provider classification.
- Capture, retrieval, worker, and correction-learning isolation controls.

### Known limitations

- The Alpha supports Windows and GitHub Copilot CLI `1.0.82-0` only.
- Node.js `22.18` or later in the Node.js 22 line must already be installed.
- Windows 10/11 capture, remote marketplace upgrade, and provider-degradation
  evidence must be collected before publication.
- The release does not include M3-M6 delayed outcome, retrospective, or
  playbook automation.
- This evidence-collection candidate is not the final M0-approved Alpha.
- Superseded by `0.1.0-alpha.0.1` because marketplace ref detection could
  incorrectly disable capture after installation.
