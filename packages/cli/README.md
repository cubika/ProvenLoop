# @provenloop/cli

Windows Design Partner Preview `0.1.0-alpha.0.12` for ProvenLoop and GitHub
Copilot CLI (2026-09-08). M0/MVP remain No-Go for quality release; controlled
benefit has not been established.

Install the exact GitHub Release tarball through the versioned bootstrap:

```powershell
irm https://raw.githubusercontent.com/cubika/ProvenLoop/v0.1.0-alpha.0.12/install.ps1 | iex
```

The installer verifies the checksum and uses npm only as the local package
installer. This preview is not published to the public npm registry. Before
upgrading from 0.11 or earlier, close Sessions that loaded those runtimes.
The canonical database moves from published schema 10 to schema 14; retain
the prior runtime and verified snapshot. Start new Sessions after upgrade.

Automatic collection is enabled on a fresh install. The bootstrap enables
retrieval and correction-learning capabilities unless `-NoLearning` is used,
and preserves existing settings on upgrade. Use `-NoAutoCollect` with the
bootstrap, `--no-auto-collect` with `provenloop install`, or
`provenloop collection disable` to opt out of collection.

Background learning requires explicit consent. It can extract candidates from
ordinary corrections and captured agent investigation. Research and broad
semantic findings remain candidates; automatic activation requires supported
native recovery proof. With capture and the worker enabled:

```powershell
provenloop enable retrieval
provenloop enable correction_learning
provenloop learning enable --confirm
provenloop learning approve-hooks --cwd C:\path\to\repository --confirm
provenloop learning status
```

The opt-in permits bounded, redacted conversation and tool excerpts to be sent
to Copilot with the existing sign-in, including agent summaries and tool results.
Background requests have no tools or plugins. Automatic hooks are verified only
on Copilot CLI `1.0.84-1`; approve each repository root and restart its Session.

Participating runtimes pause new ProvenLoop work during upgrade and wait up to
15 seconds for active database work to drain. A drain timeout removes the pause
before migration or Extension shutdown. Successful upgrades still require a
Session restart; old MCP processes are not hot-reloaded.

See the [0.12 release notes](https://github.com/cubika/ProvenLoop/blob/v0.1.0-alpha.0.12/docs/releases/0.1.0-alpha.0.12.md)
and [installation guide](https://github.com/cubika/ProvenLoop/blob/v0.1.0-alpha.0.12/docs/alpha-installation.md)
for compatibility, controls, uninstall and recovery. Real provider replay used
authored excerpts; live installed-host adoption and controlled benefit remain
unmeasured. Capture remains best effort, with bounded current-session recovery.
