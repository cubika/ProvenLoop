# @provenloop/cli

Windows Design Partner Preview `0.1.0-alpha.0.14` for ProvenLoop and GitHub
Copilot CLI (2026-09-09). M0/MVP remain No-Go for quality release; controlled
benefit has not been established.

Install or upgrade through the versioned bootstrap:

```powershell
irm https://raw.githubusercontent.com/cubika/ProvenLoop/v0.1.0-alpha.0.14/install.ps1 | iex
```

The installer verifies the GitHub Release tarball checksum and uses npm as
the local package installer. This preview is not published to the public npm
registry. Schema remains 14, as in 0.12 and 0.13. Retain the prior runtime and
verified snapshots when upgrading older databases.

## Browse local knowledge and evidence

```powershell
provenloop ui
```

The command opens a local read-only viewer in the default browser. Search
knowledge, follow evidence references, inspect learning jobs, and review usage.
Keep the terminal running; Ctrl+C stops the viewer. Run `provenloop ui` again
to reopen it after shutdown, using the new URL printed by the command.

Use `--no-open` to open the URL yourself, `--port 4317` to choose a port, or
`--data-root` to inspect another local installation. The viewer binds only to
`127.0.0.1` and does not edit data or enable learning. It includes its own assets
and needs no separate UI installation.

## Automatic learning

Automatic collection is enabled on a fresh install. The bootstrap enables
retrieval and correction-learning capabilities unless `-NoLearning` is used,
and preserves existing settings on upgrade. Use `-NoAutoCollect` with the
bootstrap or `provenloop collection disable` to opt out of collection.

Background learning requires separate explicit consent. With capture and the
worker enabled, review the disclosure before opting in:

```powershell
provenloop learning enable --confirm
provenloop learning approve-hooks --cwd C:/path/to/repository --confirm
provenloop learning status
```

This permits bounded, redacted conversation and tool excerpts to be sent to
Copilot with the existing sign-in. Background requests have no tools or plugins.
Automatic hooks are verified on Copilot CLI `1.0.84-1`; approve each repository
root and restart its session. Research and broad semantic findings remain
candidates; automatic activation requires supported recovery proof.

Upgrade coordinates participating runtimes and retires only verified ProvenLoop
helpers. Foreground Copilot sessions do not all need to close, but old tools
may disconnect. Open a new session or use a host-supported reload afterward;
hot reconnection is not guaranteed.

See the [release notes](https://github.com/cubika/ProvenLoop/blob/v0.1.0-alpha.0.14/docs/releases/0.1.0-alpha.0.14.md),
[viewer guide](https://github.com/cubika/ProvenLoop/blob/v0.1.0-alpha.0.14/docs/local-viewer.md),
and [installation guide](https://github.com/cubika/ProvenLoop/blob/v0.1.0-alpha.0.14/docs/alpha-installation.md).
