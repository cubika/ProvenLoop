# ProvenLoop implementation blockers

## F0-001: Copilot event capture latency

**Owner:** Copilot adapter work package
**State:** Feasibility passed; M0 acceptance gate

Copilot CLI `1.0.82-0` delivered tested command and HTTP Hooks hundreds of
milliseconds after their event timestamps. A plugin Extension using Session
event notifications passed the initial Windows 11 feasibility spike described
in [copilot-event-capture-design.md](copilot-event-capture-design.md).

The minimal Extension probe passed the feasibility decision needed to start
Batch 1. Remaining work below blocks M0 acceptance, not workspace and contract
implementation.

Evidence collected on Windows 11 with Copilot CLI `1.0.82-0`:

- more than 1,200 events across directly reported baseline, delayed-callback,
  and throwing-callback runs;
- all-event delivery P95 varied from 1 ms to 1528 ms because some prompt-mode
  startup events are buffered until the Extension joins;
- delivery latency is tracked as capture freshness, not user-visible latency;
- the first corrected per-type report measured required capture events at
  1 ms P95; delayed startup events were outside the required capture set;
- corrected full callback work-duration P95 between 0.042 and 0.114 ms in the
  latest non-internal runs;
- required prompt, tool start, tool completion, assistant message, and turn end
  events observed;
- callback delay, callback exception, and Extension process exit did not stop
  foreground Copilot;
- internal Session registry skipped 87 events and persisted no normal content
  records;
- persistent opt-in and settings-based rollback worked in isolated
  `COPILOT_HOME`.

The M0 gate remains open for Windows 10, paired foreground A/B added latency,
cancel/resume/subagent coverage, load and queue-failure tests, reconciliation,
and installed-plugin lifecycle behavior.

Exit conditions:

- select a supported capture path that cannot block foreground Copilot;
- measure at least 500 representative events on Windows 10 and 11;
- use paired Extension-off and Extension-on foreground measurements;
- achieve foreground added latency P95 of 10 ms or less;
- report delivery latency separately and prove it does not create an unbounded
  backlog or unrecoverable loss;
- retain the payloads needed for event identity, tool completion, session
  identity, and explicit errors.
- prove callback backlog, Extension crash, and queue failure do not slow or
  stop foreground Copilot.
- prove the experimental opt-in persists for ordinary `copilot` launches and
  is reversed by disable or uninstall.
- recover a Session when the Extension is terminated before it can persist a
  `capture_gap`.

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
