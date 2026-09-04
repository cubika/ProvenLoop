# Changelog

All notable changes to ProvenLoop are documented here.

## [0.1.0-alpha.0.3] - Unreleased

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
