# @provenloop/cli

Windows Design Partner Preview for ProvenLoop and GitHub Copilot CLI.

Microsoft-internal preview users should install the exact GitHub Release
tarball rather than resolving ProvenLoop through an npm registry:

```powershell
irm https://raw.githubusercontent.com/cubika/ProvenLoop/v0.1.0-alpha.0.6/install.ps1 | iex
```

The npmjs package remains available as an optional public/developer channel.

Automatic collection is enabled after installation. Opt out during install
with `provenloop install --no-auto-collect`, or later run
`provenloop collection disable`.

See the repository documentation for supported versions, acceptance evidence,
upgrade, capability controls, uninstall, purge, and rollback.
