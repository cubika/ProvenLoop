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

```powershell
npm install --global @provenloop/cli@0.1.0-alpha.0.2
provenloop install
provenloop doctor
```

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

```powershell
npm install --global @provenloop/cli@0.1.0-alpha.0.2
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
2. Install the previously retained npm tarball or exact package version.
3. Run `provenloop install`.
4. Run `provenloop doctor`.

Do not delete `%LOCALAPPDATA%\ProvenLoop` during rollback. Database migrations
and release evidence must be retained with the rollback artifact.
