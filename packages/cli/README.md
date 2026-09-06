# @provenloop/cli

Windows Design Partner Preview `0.1.0-alpha.0.9` for ProvenLoop and GitHub
Copilot CLI (2026-09-06). This is an evidence candidate, not M0/MVP approval
or proof of controlled benefit.

Microsoft-internal preview users should install the exact GitHub Release
tarball rather than resolving ProvenLoop through an npm registry:

```powershell
irm https://raw.githubusercontent.com/cubika/ProvenLoop/v0.1.0-alpha.0.9/install.ps1 | iex
```

The installer verifies the Release tarball checksum and uses npm only as the
local package installer. This preview is not being published to the public npm
registry.

Automatic collection is enabled after installation. Opt out during install
with `provenloop install --no-auto-collect`, or later run
`provenloop collection disable`.

See the repository documentation for supported versions, acceptance evidence,
upgrade, capability controls, uninstall, purge, and rollback.

See the [0.9 release notes](https://github.com/cubika/ProvenLoop/blob/v0.1.0-alpha.0.9/docs/releases/0.1.0-alpha.0.9.md) for Knowledge
review, trusted feedback, local observations, and bounded current-session
reconciliation. Missing SDK workspace metadata disables automatic backfill with
a diagnostic; capture is not lossless or a full-history import.
