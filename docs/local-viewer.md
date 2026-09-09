# Local learning viewer

Run the viewer from the existing CLI:

```powershell
provenloop ui
```

The command starts a local web server and opens the default browser. It prints
the address in the terminal. Keep that terminal running; press Ctrl+C to stop.
The operating system chooses an available port. To select a port or open the
browser yourself:

```powershell
provenloop ui --port 4317 --no-open
provenloop ui --data-root C:/path/to/ProvenLoop
```

For a development checkout, build and run the bundled CLI:

```powershell
npm run build
node packages/cli/dist/bin.js ui
```

## What can be viewed

| Page | Contents |
|---|---|
| Overview | Record counts, stored knowledge states, guidance use, viewer version, data location, and capability settings |
| Knowledge | Searchable rule text, state and scope filters, applicability, source quotations, verification receipts, conflicts, feedback, and recent use |
| Activity | Event metadata filtered by text or session, with retained content and capture limits on the detail page |
| Work episodes | Goals, recorded outcomes, source events, and outcome evidence references |
| Learning | Job state, attempts, pause reasons, results, proposals, and source references |
| Usage | Recorded context requests, returned guidance, explicit adoption counts, and feedback |

Lists show 40 records per page. Detail sections show up to 100 related records.
Use the Usage page for older context requests. Search matches substrings in the
fields described on each page; Activity search does not scan event content.
Refresh the page to read a new snapshot. All timestamps use UTC.

The viewer is an explicit local administration surface across the selected data
root. It does not run task retrieval or authorize guidance for another scope.
Knowledge state and evidence tier are shown as stored. Actual delivery still
checks scope, expiry, conflicts, and current evidence. A learning proposal with
no recovery receipt remains unverified. Missing or deleted sources are shown
as unavailable. Usage counts do not establish task success or productivity benefit.

## Local operation

The viewer uses the canonical database through a read-only SQLite connection.
It does not initialize data, migrate schemas, rebuild search indexes, run
learning, or edit knowledge. SQLite may create WAL/shared-memory coordination
files when opening an existing database. Database handles and maintenance
leases are released after each page request. An upgrade, restore, or incomplete
deletion temporarily makes records unavailable.

The server listens only on `127.0.0.1`. Each launch has a random access path;
use the full printed URL. Treat that URL as local access to the selected data.
Pages reject foreign hosts, cross-origin requests, and write methods. They use
no external assets or browser scripts, disable caching, escape captured content,
and redact recognized secret values for display. The existing CLI commands
remain the entry point for confirming, replacing, revoking, and deleting rules.

If the data cannot be read, the page shows an error with the selected location.
Check `provenloop version`, `provenloop status`, and `provenloop doctor`. A schema
mismatch requires a matching CLI or the normal upgrade procedure; opening the
viewer does not perform an upgrade.
