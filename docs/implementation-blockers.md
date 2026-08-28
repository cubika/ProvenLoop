# ProvenLoop implementation blockers

## F0-001: Copilot Hook latency

**Owner:** Copilot adapter work package
**State:** Blocking

Copilot CLI `1.0.82-0` delivered tested command and HTTP Hooks hundreds of
milliseconds after their event timestamps. The current result does not meet
the 10 ms P95 requirement.

Exit conditions:

- select a supported capture path that cannot block foreground Copilot;
- measure at least 500 representative events on Windows 10 and 11;
- include CLI dispatch and handler work in the measurement;
- achieve a P95 of 10 ms or less;
- retain the payloads needed for event identity, tool completion, session
  identity, and explicit errors.

## F0-002: Provider degradation matrix

**Owner:** Copilot adapter work package
**State:** Blocking before M0 acceptance

The signed-in path works, and Hook or MCP failure did not stop foreground
Copilot. Signed-out, rate-limited, and incompatible-version states have not
been exercised without affecting the developer's real account.

Exit conditions:

- test signed-out behavior with an isolated account or supported credential
  fixture;
- test rate limiting and provider unavailability;
- test an unsupported Copilot CLI version;
- verify explicit paused or incompatible state, durable backlog, bounded
  retry, and unaffected foreground Copilot use.

## F0-003: Remote marketplace upgrade

**Owner:** Plugin packaging work package
**State:** Blocking before installer completion

The local marketplace is loaded live, so its update command is intentionally a
no-op. This does not prove a cached remote plugin can move between versions.

Exit conditions:

- publish two versions to a test Git marketplace;
- install the first version, refresh the marketplace, and update to the second;
- verify disable, enable, uninstall, and repeated installation;
- verify configuration and user data survive upgrade and uninstall as
  specified.
