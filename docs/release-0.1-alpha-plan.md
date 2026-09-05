# ProvenLoop 0.1.0 Alpha Release Plan

**Status:** Proposed execution plan  
**Target:** `0.1.0-alpha.1`  
**Repository:** `https://github.com/cubika/ProvenLoop`  
**Updated:** 2026-09-02

**Evidence candidate:** `0.1.0-alpha.0.7` supersedes the earlier
`0.1.0-alpha.0.x` packages and collects the real Windows,
provider-degradation, and remote-upgrade evidence required to approve the
target `0.1.0-alpha.1`. It is a prerelease and must not be described as
M0-approved.

## 1. Goal

The first release is a Windows and GitHub Copilot CLI Design Partner Preview.
It should let a user install ProvenLoop without cloning the source repository,
use it during ordinary coding work, collect bounded M0 acceptance evidence, and
remove it without losing or corrupting unrelated Copilot configuration.

This release does not add M3-M6 product capabilities. Its job is to turn the
implemented M0-M2 code into an installable, observable, and reversible product.

The release is complete only when:

- installation uses a published package rather than a source checkout;
- the Copilot Extension and MCP run from installed assets;
- M0 blockers are evaluated from retained evidence instead of hard-coded
  `blocked` checks;
- normal daily work can produce a privacy-safe acceptance report;
- installation, upgrade, disable, uninstall, and rollback are reproducible;
- the MVP aggregate gate reaches at least `Conditional Go`.

## 2. Release scope

### Included

- GitHub Copilot CLI adapter;
- non-blocking Extension event capture;
- durable local queue and worker;
- canonical SQLite storage;
- Work Episode projection;
- M1 Branch Context and scoped retrieval;
- MCP Context, Explain, and Feedback;
- explicit Remember, Correct, Mute, Forget, Delete, and Purge;
- M2 verified correction learning;
- Knowledge lifecycle and counterevidence handling;
- M0, M1, M2, and MVP evaluation gates;
- daily M0 evidence collection scripts;
- package installation, upgrade, disable, uninstall, and rollback.

### Excluded

- M3 automated delayed Outcome Linker;
- M4 Deep Retrospective;
- M5 Playbook generation or activation;
- additional coding-agent adapters;
- cross-machine or team synchronization;
- web dashboard;
- cloud storage;
- model fine-tuning.

Disabled or deferred capabilities must remain visibly unavailable rather than
returning success-shaped placeholders.

## 3. Intended installation experience

The Alpha should support:

```powershell
irm https://raw.githubusercontent.com/cubika/ProvenLoop/v0.1.0-alpha.0.7/install.ps1 | iex
```

For the Microsoft-internal Design Partner preview, the versioned GitHub
Release tarball is the canonical runtime source. npm is used only as the local
installer and must not resolve ProvenLoop through a registry. The tarball and
its SHA-256 file must be downloaded from the same immutable Git tag and
verified before installation.

The bootstrap installer must check prerequisites, verify the Release SHA-256,
install the local tarball without registry resolution, register the Copilot
integration, enable the in-scope learning capabilities, run Doctor, and clean
all temporary package files.

Public npm and a future governed Azure Artifacts path are optional secondary
channels. If O365 internal distribution later uses Azure Artifacts, the
expected model is an approved producer pipeline and Feed, normally Common,
with consumption through Enzyme; direct Enzyme publishing requires explicit
owner approval.

`provenloop install` should:

1. initialize `%LOCALAPPDATA%\ProvenLoop`;
2. register the official Copilot marketplace;
3. install and enable the ProvenLoop plugin;
4. register the Extension and local MCP server;
5. verify the installed runtime and supported Copilot version;
6. preserve the user's existing Copilot settings;
7. report a clear incompatible state instead of partially installing.

No installed manifest may reference the source checkout or a developer-specific
absolute path.

A later Windows release may use Winget or MSI and bundle Node.js. The first
Alpha may require the pinned Node.js 22 runtime.

## 4. Delivery order

```text
release package
  -> remote marketplace
  -> M0 evidence contract
  -> daily acceptance scripts
  -> capture and degradation evidence
  -> capability isolation
  -> M0 Gate
  -> MVP Gate
  -> Alpha release
```

Recommended branches:

```text
feat/r0-release-package
feat/r0-remote-marketplace
feat/m0-acceptance-evidence
feat/f0-daily-acceptance
feat/f0-provider-doctor
feat/m0-capability-isolation
release/0.1.0-alpha.1
```

Each branch starts from `master`, passes its targeted acceptance tests, and is
merged before the dependent branch starts.

## 5. Workstream A: publishable runtime package

- [ ] Set the final root and publishable package version to `0.1.0-alpha.1`
  after the `0.1.0-alpha.0.x` evidence period.
- [x] Keep internal-only packages private or bundle them into the public CLI.
- [x] Produce one publishable `@provenloop/cli` package.
- [x] Bundle the CLI, MCP server, worker, and Extension runtime.
- [x] Include required schemas, migrations, and built-in evaluation fixtures.
- [x] Remove runtime references to `packages\*\dist` in the source checkout.
- [x] Resolve installed assets from the package installation directory.
- [x] Verify `npm pack` contains every runtime file and no test/private data.
- [x] Install the packed tarball into a clean temporary user environment.
- [x] Publish the exact tarball and SHA-256 through GitHub Releases.
- [x] Document registry-independent installation from the GitHub Release
  tarball.
- [x] Run `install`, `status`, `doctor`, `worker run`, and `uninstall` from the
  packed artifact.
- [x] Verify uninstall preserves `%LOCALAPPDATA%\ProvenLoop` unless `--purge`
  is supplied.
- [x] Verify purge refuses an unowned or ambiguous data root.

Package smoke testing must use the tarball, not workspace module resolution.

## 6. Workstream B: official remote Copilot marketplace

Create the release layout:

```text
.github\
  plugin\
    marketplace.json
plugins\
  provenloop\
    plugin.json
    .mcp.json
    extensions\
      event-capture\
        extension.mjs
```

- [x] Add the official marketplace metadata to this repository.
- [x] Give the marketplace and plugin stable, non-local names.
- [x] Make `.mcp.json` launch the installed ProvenLoop CLI/runtime.
- [x] Make the Extension import only bundled or plugin-local assets.
- [x] Replace the generated `provenloop-local` production path.
- [x] Retain the local marketplace only for isolated development tests.
- [ ] Publish two test versions.
- [ ] Install the first version from the Git repository.
- [ ] Refresh the marketplace and upgrade to the second version.
- [ ] Verify disable, enable, uninstall, and repeated installation.
- [ ] Verify local Knowledge and queue data survive upgrade and normal
  uninstall.
- [ ] Verify user-owned Copilot experimental settings are restored exactly.

This work closes F0-003 only after a real two-version remote upgrade succeeds.

## 7. Workstream C: M0 acceptance evidence contract

Add a versioned evidence schema, for example:

```text
packages\evaluation\src\m0-acceptance-evidence.ts
packages\evaluation\fixtures\m0-acceptance-evidence-template-v1.json
```

Extend the command:

```powershell
provenloop eval m0 `
  --out .provenloop\evaluation `
  --evidence .provenloop\m0-evidence.json
```

The evidence must bind:

- Git code version;
- executable runtime digest;
- operating-system version;
- Copilot CLI version;
- plugin version;
- fixture and probe versions;
- capture run IDs;
- retained report digests.

Required sections:

```json
{
  "capture": {},
  "providerDegradation": {},
  "marketplaceUpgrade": {},
  "doctor": {},
  "capabilityIsolation": {},
  "observedGuardrails": {}
}
```

- [x] Add strict schema validation and safe identifier rules.
- [x] Reject secret-bearing evidence and unsafe paths.
- [x] Require evidence files and output below an ignored directory or outside
  the repository.
- [x] Reject evidence from another code, runtime, plugin, or probe version.
- [x] Replace `knownBlockedChecks()` with evidence-driven checks.
- [x] Preserve `blocked` for missing evidence, `fail` for failed thresholds,
  `2` for invalid evidence, and `3` for infrastructure failure.
- [x] Publish the complete run through an atomic staging directory.
- [x] Add tests for stale, forged, incomplete, and mismatched evidence.

## 8. Workstream D: daily acceptance scripts

Daily evidence collection should require little more than starting a run,
working normally, and completing the run.

Planned commands:

```powershell
.\spikes\f0\start-daily-acceptance.ps1

# Use Copilot normally for several hours.

.\spikes\f0\complete-daily-acceptance.ps1
```

Optional controlled probes:

```powershell
.\spikes\f0\run-paired-latency-probe.ps1
.\spikes\f0\run-fault-isolation-probe.ps1
.\spikes\f0\run-capability-isolation-probe.ps1
```

### Start script

- [x] Record the run ID, UTC start time, OS version, Copilot version, plugin
  version, code version, and runtime digest.
- [x] Capture initial queue, worker, database, and capability health.
- [x] Record canonical high-water marks without copying Prompt or code text.
- [x] Refuse to start when another acceptance run is active.
- [x] Store state below `%LOCALAPPDATA%\ProvenLoop\evaluation\m0-daily`.

### Completion script

- [x] Record the end time and final health snapshot.
- [x] Drain the worker with a bounded timeout.
- [x] Run Session-file reconciliation.
- [x] Compare queue and canonical high-water marks.
- [x] Calculate event counts by supported event type.
- [x] Calculate callback work duration and delivery-latency distributions.
- [x] Detect capture gaps, missing events, duplicate facts, retry items, and
  dead letters.
- [x] Run seeded-secret and internal-Session persistence checks.
- [x] Write stable JSON and Markdown reports.
- [x] Never include raw Prompt, code, tool arguments, or tool results in the
  acceptance report.

Planned output:

```text
%LOCALAPPDATA%\ProvenLoop\evaluation\m0-daily\<run-id>\
  run.json
  environment.json
  capture-metrics.json
  reconciliation.json
  guardrails.json
  report.json
  report.md
```

## 9. Workstream E: F0-001 capture acceptance

Use daily work for natural event coverage and controlled probes for paired or
fault scenarios.

Required scenarios:

- [ ] Prompt submission.
- [ ] Tool success.
- [ ] Tool failure.
- [ ] Cancellation.
- [ ] Resume.
- [ ] Shutdown.
- [ ] Subagent start, completion, and failure.
- [ ] Extension callback delay.
- [ ] Extension callback exception.
- [ ] Extension process termination.
- [ ] Worker stopped.
- [ ] Queue backlog.
- [ ] Queue write failure.
- [ ] Reconciliation after a capture gap.
- [ ] Reconciliation when the Extension dies before writing `capture_gap`.

Required environments:

- [ ] Windows 11, at least 500 representative events.
- [ ] Windows 10, at least 500 representative events; alternatively revise the
  Alpha support statement and M0 requirement explicitly before release.

Hard thresholds:

```text
foreground added latency P95 <= 10 ms
callback work duration P95 <= 1 ms
missing required events after reconciliation = 0
duplicate canonical facts = 0
seeded secret persistence = 0
internal Session content persistence = 0
foreground Copilot blocking failures = 0
```

Delivery latency is reported separately from user-visible added latency.

## 10. Workstream F: F0-002 provider degradation and Doctor

Default Doctor must remain passive and must not consume a model request or
inspect credentials.

Add an explicit online mode:

```powershell
provenloop doctor --online
```

- [x] Add an opt-in, bounded Copilot availability probe.
- [x] Give the probe no tool permissions and require a fixed response.
- [x] Apply a strict timeout and classify errors without persisting provider
  output.
- [x] Report `available`, `signed_out`, `rate_limited`, `incompatible`, or
  `unavailable`.
- [x] Keep passive Doctor status as `unverified` when no supported credential
  status API exists.
- [x] Use an isolated `COPILOT_HOME` or test account.
- [x] Test signed-out behavior.
- [x] Test rate limiting.
- [x] Test provider unavailability.
- [x] Test an unsupported Copilot version.
- [ ] Verify backlog remains durable and retry remains bounded.
- [ ] Verify foreground Copilot remains usable.

This work closes F0-002 only when the real degradation matrix is retained as
version-bound evidence.

## 11. Workstream G: capability isolation

Required capability checks:

### Retrieval disabled

- [x] Context returns no Knowledge.
- [x] Feedback fails explicitly.
- [x] Capture remains operational.
- [x] Worker continues canonical ingestion.

### Capture disabled

- [x] New Extension events stop.
- [x] Existing Knowledge remains retrievable.
- [x] Worker and deletion remain usable.
- [x] Copilot remains usable.

### Worker disabled

- [x] Durable queue backlog is preserved.
- [x] No consumer side effects occur.
- [x] Existing projected Knowledge remains retrievable.
- [x] Re-enabling the worker drains backlog without duplicates.

### Correction learning disabled

- [x] Correction events may remain observable.
- [x] Correction Knowledge lifecycle side effects stop.
- [x] Existing manually remembered Knowledge remains independent.

- [x] Add one end-to-end isolation matrix test.
- [x] Add a real installed-plugin probe.
- [x] Bind the result into M0 evidence.
- [x] Remove the hard-coded M0 capability-isolation blocker only after both
  tests pass.

## 12. Daily-use evidence period

The initial collection period should last several working days.

### Day 0

- install the packaged Alpha candidate;
- run `provenloop doctor`;
- start a daily acceptance run;
- verify capture, worker, and retrieval status;
- record the exact Copilot and Windows versions.

### Days 1-3

- use Copilot normally;
- include multiple repositories and branches;
- start new Sessions and resume existing work;
- perform real tests and builds;
- include at least one explicit correction;
- include at least one failed command followed by recovery;
- complete one acceptance report per day.

### Controlled fault window

Run separately from important work:

- stop the worker and create queue backlog;
- disable and re-enable retrieval;
- disable and re-enable capture;
- terminate the Extension during a test Session;
- run reconciliation;
- confirm Copilot foreground work remains usable.

Do not deliberately sign out, rate-limit, or corrupt the real user profile.
Provider degradation tests require an isolated profile or test account.

## 13. What to return after several days

Share only:

- `report.json`;
- `report.md`;
- M0 evidence JSON;
- observed error messages;
- Windows and Copilot versions;
- a description of user-visible slowdown or incorrect behavior.

Do not share:

- `provenloop.db`;
- `knowledge.db`;
- raw queue files;
- raw Session files;
- Prompt or tool-result logs;
- credentials or Copilot configuration containing secrets.

The follow-up review should classify each failure as:

```text
capture correctness
foreground performance
reconciliation
provider degradation
capability isolation
installation lifecycle
reporting or evidence integrity
```

## 14. Release engineering

- [x] Add `LICENSE`.
- [x] Add `CHANGELOG.md`.
- [x] Add `SECURITY.md`.
- [x] Document supported Windows, Node.js, and Copilot versions.
- [x] Add installation, upgrade, disable, uninstall, and purge documentation.
- [x] Add a tag-triggered release workflow.
- [ ] Run clean checkout validation.
- [x] Run packed-artifact validation.
- [x] Generate checksums for published artifacts.
- [ ] Publish GitHub Release notes with known limitations.
- [ ] Retain the M0 and MVP reports used for the decision.
- [ ] Verify the Git tag resolves to the evaluated code version.

Software signing and Winget packaging may follow the first private Alpha, but a
public Windows release should not distribute unsigned mutable binaries without
an explicit warning and checksum.

## 15. Release decision

Before publishing:

```powershell
provenloop eval m0 `
  --out .provenloop\evaluation `
  --evidence .provenloop\m0-evidence.json

provenloop eval mvp `
  --out .provenloop\evaluation `
  --evidence .provenloop\release-evidence.json `
  --stable
```

Required result:

```text
M0: PASS
MVP: GO or explicitly bounded CONDITIONAL GO
```

`No-Go`, missing evidence, stale evidence, an unverified rollback target, or a
non-zero safety count blocks publication.

## 16. Definition of done

- [ ] A user can install from a published package without cloning the repo.
- [ ] Installed Plugin and MCP paths survive moving or deleting the source
  checkout.
- [ ] A clean profile can install, upgrade, disable, uninstall, and reinstall.
- [ ] Normal uninstall preserves user data.
- [ ] Purge removes only the owned ProvenLoop data root.
- [ ] Daily work produces bounded, privacy-safe M0 evidence.
- [ ] F0-001, F0-002, and F0-003 are closed with retained evidence.
- [ ] Capability isolation passes in tests and an installed environment.
- [ ] M0 exits with code `0`.
- [ ] MVP produces Go or bounded Conditional Go.
- [ ] `0.1.0-alpha.1` is tagged from the evaluated commit.
- [ ] Published artifacts match the retained runtime digest.

Only after this release is operating safely should work begin on M3 automated
delayed Outcome linking.
