# ProvenLoop 0.1 Alpha installation

## Supported environment

| Component | Supported version |
|---|---|
| Operating system | Windows 10 or Windows 11, x64 |
| Node.js | `>=22.18.0 <23` |
| npm | `>=11 <12` |
| GitHub Copilot CLI | `1.0.82-0` |
| ProvenLoop | `0.1.0-alpha.0.2` evidence candidate |

Other versions fail closed as incompatible. The Alpha does not bundle Node.js.

## Install

For the Microsoft-internal Design Partner preview, the canonical installation
source is the exact tarball attached to the versioned GitHub Release:

```powershell
$version = "0.1.0-alpha.0.2"
$release = "https://github.com/cubika/ProvenLoop/releases/download/v$version"
$package = Join-Path $env:TEMP "provenloop-cli-$version.tgz"
$checksum = "$package.sha256"

Invoke-WebRequest "$release/provenloop-cli-$version.tgz" `
  -OutFile $package
Invoke-WebRequest "$release/provenloop-cli-$version.tgz.sha256" `
  -OutFile $checksum

$expected = (Get-Content $checksum -Raw).Trim().Split()[0]
$actual = (Get-FileHash $package -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) {
  throw "ProvenLoop package checksum mismatch."
}

npm install --global $package --no-audit --no-fund
provenloop install
provenloop doctor
```

The tarball contains the complete ProvenLoop runtime and has no runtime npm
dependencies. npm is used only to place the files in a stable installation
directory and create the `provenloop` command. It does not resolve ProvenLoop
through npmjs, `packagefeedproxy.microsoft.io`, or Azure Artifacts.

The installer registers the release-pinned
`cubika/ProvenLoop#v0.1.0-alpha.0.2` marketplace, installs
`provenloop@provenloop-marketplace`, and preserves existing JSONC settings.
The MCP server runs through the globally installed `provenloop` command. The
Extension is bundled in the plugin and does not reference a source checkout.
Capture and the background worker are enabled automatically. To install
without collecting any events:

```powershell
provenloop install --no-auto-collect
```

## Upgrade

Download and verify the new version's GitHub Release tarball, then install it
from the local file:

```powershell
npm install --global <downloaded-provenloop-tarball> --no-audit --no-fund
provenloop upgrade
provenloop doctor
```

Upgrade refreshes the marketplace and plugin without removing the queue,
canonical database, Knowledge database, or user settings.

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

## Daily M0 acceptance

```powershell
.\spikes\f0\start-daily-acceptance.ps1

# Use Copilot normally.

.\spikes\f0\complete-daily-acceptance.ps1
```

Reports are written below
`%LOCALAPPDATA%\ProvenLoop\evaluation\m0-daily`. They contain aggregate
metrics and stable identifiers, never raw prompts, code, tool arguments, or
tool results.

Controlled probes:

```powershell
.\spikes\f0\run-paired-latency-probe.ps1
.\spikes\f0\run-provider-doctor-probe.ps1 -ExpectedStatus signed_out
.\spikes\f0\run-capability-isolation-probe.ps1
.\spikes\f0\run-fault-isolation-probe.ps1
```

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

Purge refuses an unowned, ambiguous, or active data root.

## Rollback

1. Run `provenloop uninstall`.
2. Download and verify the previous version's GitHub Release tarball.
3. Install that local tarball with `npm install --global <tarball>`.
4. Run `provenloop install`.
5. Run `provenloop doctor`.

Do not delete `%LOCALAPPDATA%\ProvenLoop` during rollback. Database migrations
and release evidence must be retained with the rollback artifact.

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

The npmjs package remains an optional public/developer distribution channel;
it is not the installation dependency for this internal preview.

This decision is recorded in
[ADR 0003](decisions/0003-design-partner-distribution.md).
