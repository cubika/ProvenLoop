# ProvenLoop 0.1 Alpha installation

**Updated:** 2026-09-06

## Supported environment

| Component | Supported version |
|---|---|
| Operating system | Windows 10 or Windows 11, x64 |
| Node.js | `>=22.16.0 <23` |
| npm | `>=11 <12` |
| GitHub Copilot CLI | `>=1.0.71` |
| ProvenLoop | `0.1.0-alpha.0.9` evidence candidate |

The URL below targets the `0.1.0-alpha.0.9` Windows Design Partner Preview.
It includes Knowledge review, local observations, the native verification
bridge, trusted feedback approval, and bounded current-session reconciliation.
See the [release notes](releases/0.1.0-alpha.0.9.md). M0/MVP remain No-Go for
quality release; `0.1.0-alpha.1` is still an unapproved target. Documentation and
prior source tests do not certify new-version artifacts or controlled benefit.

The earlier `0.1.0-alpha.0.8` tag remains immutable, but package smoke validation
stopped publication before a GitHub Release or assets were created. It is not
an available Release-tarball installation target.

The installer probes the Plugin Marketplace, plugin installation, and plugin
enable/disable commands before changing Copilot configuration. Copilot CLI
`1.0.82-0` and `1.0.83-4` are ProvenLoop-verified. Newer compatible versions
are allowed without an artificial upper bound, but Doctor marks them as
unverified until ProvenLoop evidence is collected. The Alpha does not bundle
Node.js.

## Install

For the Microsoft-internal Design Partner preview, the canonical installation
source is the exact tarball attached to the versioned GitHub Release:

```powershell
irm https://raw.githubusercontent.com/cubika/ProvenLoop/v0.1.0-alpha.0.9/install.ps1 | iex
```

The installer:

1. checks Windows, Node.js, npm, and Copilot CLI;
2. optionally installs Node.js 22 through Winget when Node is missing;
3. downloads the exact Release tarball and SHA-256 file;
4. verifies the checksum;
5. installs the local tarball into a versioned user-local runtime slot without
   contacting an npm registry;
6. upgrades the version-pinned Copilot marketplace and plugin only after the
   new runtime is verified;
7. enables capture, worker, retrieval, and correction learning;
8. runs passive Doctor.

Install without automatic event collection:

```powershell
& ([ScriptBlock]::Create(
  (Invoke-RestMethod `
    https://raw.githubusercontent.com/cubika/ProvenLoop/v0.1.0-alpha.0.9/install.ps1)
)) -NoAutoCollect
```

Install without retrieval or correction learning:

```powershell
& ([ScriptBlock]::Create(
  (Invoke-RestMethod `
    https://raw.githubusercontent.com/cubika/ProvenLoop/v0.1.0-alpha.0.9/install.ps1)
)) -NoLearning
```

For a manual tarball installation (without the bootstrap's orchestration):

```powershell
$version = "0.1.0-alpha.0.9"
$release = "https://github.com/cubika/ProvenLoop/releases/download/v$version"
$downloadRoot = New-Item -ItemType Directory -Force .\.provenloop\downloads
$package = Join-Path $downloadRoot.FullName "provenloop-cli-$version.tgz"
$checksum = "$package.sha256"

Invoke-WebRequest "$release/provenloop-cli-$version.tgz" `
  -OutFile $package `
  -UseBasicParsing
Invoke-WebRequest "$release/provenloop-cli-$version.tgz.sha256" `
  -OutFile $checksum `
  -UseBasicParsing

$expected = (Get-Content $checksum -Raw).Trim().Split()[0]
$actual = (Get-FileHash $package -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) {
  throw "ProvenLoop package checksum mismatch."
}

$runtimeSlot = Join-Path `
  $env:LOCALAPPDATA `
  "ProvenLoopRuntime\versions\$version"
npm install --global --prefix $runtimeSlot $package --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw "Runtime installation failed." }
$provenloop = Join-Path $runtimeSlot "provenloop.cmd"
& $provenloop version
& $provenloop install
if ($LASTEXITCODE -ne 0) { throw "Copilot integration failed; do not switch PATH." }
& $provenloop enable retrieval
if ($LASTEXITCODE -ne 0) { throw "Retrieval activation failed." }
& $provenloop enable correction_learning
if ($LASTEXITCODE -ne 0) { throw "Correction learning activation failed." }
& $provenloop doctor
if ($LASTEXITCODE -ne 0) { throw "Doctor failed; inspect the prior runtime before switching PATH." }

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
[Environment]::SetEnvironmentVariable(
  "Path",
  "$runtimeSlot;$userPath",
  "User"
)
$env:Path = "$runtimeSlot;$env:Path"
```

The tarball contains the complete ProvenLoop runtime and has no runtime npm
dependencies. npm is used only to place the files in a versioned user-local
runtime slot and create the `provenloop` command. The installer switches PATH
only after the new runtime validates and the Copilot integration succeeds, so
the prior runtime remains available when an upgrade fails. npm does not resolve
ProvenLoop through npmjs, `packagefeedproxy.microsoft.io`, or Azure Artifacts.

The bootstrap enables retrieval and correction learning by default unless
`-NoLearning` is supplied. Direct `provenloop install` enables capture and the
worker unless `--no-auto-collect` is supplied; the manual example enables the
learning capabilities explicitly. Manual steps are not a transactional
replacement for bootstrap rollback. Keep the previous runtime slot and stop
on any failed command before editing PATH.

The installer registers the release-pinned
`cubika/ProvenLoop#v0.1.0-alpha.0.9` marketplace, installs
`provenloop@provenloop-marketplace`, and preserves existing JSONC settings.
The MCP server runs through the globally installed `provenloop` command. The
Extension is bundled in the plugin and does not reference a source checkout.
Capture and the background worker are enabled automatically. To install
without collecting any events:

```powershell
provenloop install --no-auto-collect
```

## Upgrade

To upgrade from the previous `0.1.0-alpha.0.7` candidate, rerun the versioned
bootstrap for `0.1.0-alpha.0.9`. It stages the new runtime in a separate slot,
performs the integration upgrade, and switches the user PATH only after success:

```powershell
irm https://raw.githubusercontent.com/cubika/ProvenLoop/v0.1.0-alpha.0.9/install.ps1 | iex
```

For a manually downloaded and verified release tarball, use the same
versioned-slot path and invoke that exact new command. Do not use npm's default
global prefix or an unqualified `provenloop` command, because either can select
an older runtime:

```powershell
$version = "0.1.0-alpha.0.9"
$runtimeSlot = Join-Path `
  $env:LOCALAPPDATA `
  "ProvenLoopRuntime\versions\$version"
npm install --global --prefix $runtimeSlot `
  <downloaded-provenloop-tarball> --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw "Runtime installation failed." }
$provenloop = Join-Path $runtimeSlot "provenloop.cmd"
& $provenloop version
& $provenloop upgrade
if ($LASTEXITCODE -ne 0) { throw "Upgrade failed; do not switch PATH." }
& $provenloop doctor
if ($LASTEXITCODE -ne 0) { throw "Doctor failed; do not switch PATH." }

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
[Environment]::SetEnvironmentVariable(
  "Path",
  "$runtimeSlot;$userPath",
  "User"
)
$env:Path = "$runtimeSlot;$env:Path"
```

Upgrade retains the previous runtime slot until the new marketplace, plugin,
runtime locator, and capability state all succeed. If marketplace or plugin
replacement fails, ProvenLoop restores the prior registration and leaves the
previous active runtime on PATH when using the bootstrap. Integration rollback
alone does **not** undo a database migration. Upgrade preserves local data, but an
older runtime may reject the new canonical schema. Before a cross-schema
upgrade, retain a compatible database backup and recovery plan; see Rollback.

The default data root is `%LOCALAPPDATA%\ProvenLoop`: canonical data lives in
`data\provenloop.db`, the rebuildable search index in `backends\knowledge.db`,
and queue, artifacts, evaluation, integration, and logs in separate child
directories. `%LOCALAPPDATA%\ProvenLoopRuntime\versions\<version>` contains
installed code, not canonical user data.

### Maintenance migrations — 0.9 preview

The current schema is 10. Existing older databases require explicit
`provenloop upgrade`; ordinary runtime opens do not silently migrate them.
Upgrade takes maintenance leases, waits for Extensions to stop, and retains
`data\backups\pre-upgrade-<id>.db` with its deletion key, manifest, and available
runtime locator before changing schema. Failed integration replacement can
restore that snapshot only when no intervening canonical writes occurred.
Otherwise it preserves data/snapshots and pauses capabilities for review.
Do not delete the recovery journal or force the old runtime to open new data.

## Automatic capture and recovery

The installed Extension runs worker/admission first, then bounded current-session
reconciliation and observation collection on a 30-second schedule. Actual
queued/enriched progress or an exhausted reconciliation budget schedules a
two-second catch-up; runtime shutdown stops the loop. It validates capability
state, paths, and leases and excludes records before the join-time observation
boundary.

Automatic reconciliation requires the joined SDK Session's `sessionId` and
`workspacePath` to match the trusted Session locator and state directory.
Missing or mismatched metadata produces a diagnostic and skips automatic
backfill; the runtime does not guess paths or enumerate historical Sessions.
Capture is best effort, not lossless archival. Bounded enrichment preserves
original source evidence and does not make unsupported or missing events complete.

## Capability controls

```powershell
provenloop disable retrieval
provenloop enable retrieval

provenloop disable capture
provenloop enable capture

provenloop disable worker
provenloop enable worker

provenloop disable correction_learning
provenloop enable correction_learning
```

Disabled capabilities report their state explicitly. They do not return
success-shaped placeholder results.

Disabling the worker while leaving capture enabled preserves pending work but
can grow disk usage: the durable queue has no total storage quota. Its
seven-day acknowledged-item pruning is not pending/dead-letter or canonical
raw-event retention. Use Doctor to inspect backlog and disk health.

Use the collection shortcut to control both capture and the worker:

```powershell
provenloop collection disable
provenloop collection enable
```

## Doctor

Passive Doctor does not inspect credentials or consume a model request:

```powershell
provenloop doctor
```

The online probe is explicit, bounded, has no available tools, and does not
persist provider output:

```powershell
provenloop doctor --online
```

It classifies the provider as `available`, `signed_out`, `rate_limited`,
`incompatible`, or `unavailable`.

## First useful use

Start with an explicitly chosen, narrowly scoped rule rather than waiting for
automatic learning:

```powershell
provenloop enable retrieval
provenloop remember `
  --content "Inspect package scripts and run the targeted repository test." `
  --when "running repository tests" --scope repository
```

Open a new Copilot Session in the same repository. Ask it to call
`provenloop_context`, inspect the returned rule using `provenloop_explain`,
and give explicit feedback after trying it. Retrieval proves only that context
was offered. A user-confirmed rule is not externally verified learning.
The [README workflow](../README.md#first-useful-workflow) includes
Knowledge list/show/confirm/replace/revoke commands and feedback approval.
Each Knowledge mutation requires the latest reviewed digest and `--confirm`.
Workflow scope additionally requires a matching live SDK `SESSION_ID`, workflow,
and `--cwd`; flags alone cannot authorize it.

### Local observations

Ordinary preview use collects bounded local observations without daily
acceptance start/stop commands:

```powershell
provenloop observations show
provenloop observations show --date 2026-09-06 --session <session-id>
provenloop observations export --date 2026-09-06 |
  Set-Content -Encoding utf8 .\provenloop-observations.json
```

The default date is today in UTC. Export prints a current-code-version
observational manifest, not raw records, to stdout. Files live below
`%LOCALAPPDATA%\ProvenLoop\evaluation\observations`.
Counts distinguish provided context, explicit adoption reports, and feedback;
unknown outcomes, absent coverage, and unmeasured safety remain unknown.
An empty export does not prove there were no errors, and these observations
cannot establish controlled benefit or release approval. Inspect the selected
export before sharing it; do not share the whole observations directory.

## Explicit M0 acceptance — maintainer experiment

The installed CLI supports bounded acceptance windows:

```powershell
provenloop acceptance start
# Use Copilot normally, then close the Sessions in the experiment.
provenloop acceptance complete
```

An acceptance window is an evidence boundary, not the capture on/off switch.
Use `provenloop collection enable` or `disable` to control collection.
Reports are written below
`%LOCALAPPDATA%\ProvenLoop\evaluation\m0-daily`. They contain aggregate
metrics and stable identifiers, never raw prompts, code, tool arguments, or
tool results. Reconciliation reports coverage of supported, accessible Session
files; it cannot count events that neither capture nor those files retained.

### Source-checkout controlled probes

These scripts are maintainer tools, not required daily steps for package users:

```powershell
.\spikes\f0\run-paired-latency-probe.ps1 `
  -BaselineSamples .provenloop\foreground-baseline-ms.json `
  -ProvenLoopSamples .provenloop\foreground-provenloop-ms.json
.\spikes\f0\run-provider-doctor-probe.ps1 -ExpectedStatus signed_out
.\spikes\f0\run-capability-isolation-probe.ps1 `
  -AutomatedTestReport .provenloop\capability-tests.json
.\spikes\f0\run-fault-isolation-probe.ps1
```

The paired-latency script analyzes supplied measurements; it does not run a
benchmark. Supply two equal-length JSON arrays of at least 100 finite,
non-negative millisecond observations, paired by caller-controlled order.
The capability probe exercises installed switches and validates an external
automated-test report; it does not execute those tests. Retain the reports
and their digests separately from maintainer attestations. Neither probe
substitutes for the full native-event or Windows acceptance matrix.

Provider degradation must use an isolated `COPILOT_HOME` or test account.
After collecting the section reports, assemble the strict M0 evidence file:

```powershell
.\spikes\f0\build-m0-evidence.ps1 `
  -BaselineM0Report <m0-report.json> `
  -CaptureReport <capture-summary.json> `
  -ProviderDegradationReport <provider-summary.json> `
  -MarketplaceUpgradeReport <marketplace-upgrade-report.json> `
  -CapabilityIsolationReport <capability-isolation-report.json> `
  -ObservedGuardrailsReport <guardrails-summary.json> `
  -OutputPath .provenloop\m0-evidence.json
```

## Uninstall and purge

Normal uninstall removes the Copilot integration and preserves local data:

```powershell
provenloop uninstall
```

Purge removes only an ownership-verified ProvenLoop data root:

```powershell
provenloop uninstall --purge
```

Purge refuses an unowned or ambiguous data root. It also requests active
Extensions to stop and waits for their confirmed shutdown; if any Extension
does not stop before the deadline, it preserves all data and instructs the user
to close Copilot before retrying.

## Rollback

Git rollback, runtime switching, and data recovery are different operations.
A Git commit existing is not proof that its runtime can read a newer database.
Do not point an old runtime at a migrated data root just because the previous
runtime slot is still present.

1. Close Copilot Sessions and stop collection/worker activity.
2. Retain a consistent recovery backup, schema/runtime identity, and release
   evidence. Do not copy a live WAL database as if it were a complete backup.
3. Establish that the previous runtime supports the current schema, or arrange
   maintainer-assisted recovery of a compatible snapshot with deletion
   tombstones preserved. There is no documented user-facing restore CLI.
4. Run `provenloop uninstall` without purge.
5. Download and verify the previous tarball, then install it in its own slot
   **only after** the data-compatibility check or recovery has succeeded:

```powershell
$version = "<previous-version>"
$runtimeSlot = Join-Path `
  $env:LOCALAPPDATA `
  "ProvenLoopRuntime\versions\$version"
npm install --global --prefix $runtimeSlot `
  <downloaded-provenloop-tarball> --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw "Runtime installation failed." }
$provenloop = Join-Path $runtimeSlot "provenloop.cmd"
& $provenloop version
& $provenloop install
if ($LASTEXITCODE -ne 0) { throw "Integration failed; do not switch PATH." }
& $provenloop doctor
if ($LASTEXITCODE -ne 0) { throw "Doctor failed; do not switch PATH." }

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
[Environment]::SetEnvironmentVariable(
  "Path",
  "$runtimeSlot;$userPath",
  "User"
)
$env:Path = "$runtimeSlot;$env:Path"
```

Do not delete `%LOCALAPPDATA%\ProvenLoop` as a rollback shortcut. Backup restore
must not resurrect deleted sources or Knowledge. Independently copied backups
and exported files remain the owner's responsibility; do not share them as
diagnostics. Consult the [storage boundaries](architecture.md#5-storage-architecture)
for the 0.9 preview migration and restore contract.

## Distribution decision

The Design Partner preview deliberately uses GitHub Release tarballs instead
of an internal npm Feed:

- it is immediately available without the public npm/CFS quarantine period;
- it avoids onboarding ProvenLoop as a publisher to a shared O365 Feed;
- the package, checksum, Git tag, source commit, and release notes remain
  together;
- the existing tested npm package layout and global command shims are reused.

An internal Azure Artifacts path may be added when the internal audience grows.
For O365, the expected governed model is publication through an approved
pipeline to the designated producer Feed, normally Common, with consumption
through Enzyme. Direct publication to Enzyme is not assumed without approval
from its owners.

This 0.9 preview is not being published to the public npm registry. Any separate
public/developer npm channel is not an installation dependency for this preview.

This decision is recorded in
[ADR 0003](decisions/0003-design-partner-distribution.md).
