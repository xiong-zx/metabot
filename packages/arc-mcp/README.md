# AutoResearchClaw MCP

`@xvirobotics/arc-mcp` is an independent AutoResearchClaw (ARC) lifecycle
service. It owns versioned input, output, and run contracts, project-local
artifacts, durable SQLite run state, and six stdio MCP tools:

- `arc_run_start`
- `arc_run_get`
- `arc_run_list`
- `arc_run_pause`
- `arc_run_resume`
- `arc_run_cancel`

The package does not import MetaBot Bridge, Memory Core, Wiki ingest,
WorkerManager, Agent Team, or engine-specific code. It never promotes a result
to memory. A runner is supplied through the small `ArcRunner` interface; a
future Memory MCP may consume the validated output through the separate
`ArcResultConsumer` interface.

## Contracts and artifacts

- input: `autoresearchclaw.input.v1`
- output: `autoresearchclaw.output.v2`
- durable run: `autoresearchclaw.run.v1`

The runner writes the authoritative output JSON to
`.metabot-arc/runs/<run-id>/output.json` under the canonical project root. ARC
validates the complete nested contract before marking the run terminal. Local
artifact and evidence paths must be real files inside that root; HTTP(S)
evidence is allowed. Atomic writes reject traversal and symbolic-link paths.
Entity IDs must be unique within each result collection. References from
experiments, negative results, and decisions must resolve to declared
hypotheses, artifacts, experiments, and findings. Objectives are limited to 16
KiB and the JSON-encoded parameters object to 64 KiB.

`memory_event_candidates`, when present, is an opaque extension. ARC does not
validate it as a Memory type, review it, or publish it.

## Standalone server configuration

Build the workspace, then configure an MCP client with this generic command and
environment tuple:

```json
{
  "command": "metabot-arc-mcp",
  "args": [],
  "env": {
    "METABOT_ARC_DATA_DIR": "/absolute/private/state/directory",
    "METABOT_ARC_PROJECT_ROOTS": "[\"/absolute/project/root\"]",
    "METABOT_ARC_PROJECT_ID": "optional-fixed-project-id",
    "METABOT_ARC_RUNNER_MODULE": "/absolute/path/to/runner-adapter.js"
  }
}
```

The runner module must export `createArcRunner()`. Its returned object implements
`start`, `pause`, `resume`, `cancel`, and `collect`. The runner handle must be a
JSON-safe object with an `id`, so a paused run can survive MCP process restart.
`METABOT_ARC_DATA_DIR` is required; the server never defaults state into the
repository or a broad shared directory.

`METABOT_ARC_PROJECT_ROOTS` is also required and must be a non-empty JSON array.
The server canonicalizes each root and matches it exactly. It will not start,
list, read, pause, resume, or cancel runs outside those roots. Set
`METABOT_ARC_PROJECT_ID` to bind the server to one project ID as well. A missing
root policy fails server startup instead of accepting arbitrary directories.

Only one server process may own a data directory. ARC holds an exclusive lock
containing the process ID, host, instance ID, and start time. A second live
owner fails startup. A verifiably dead owner is archived as a stale-lock
diagnostic before recovery continues; an owner on another host is treated as
unverifiable and is never removed automatically.

## Runner lifecycle contract

`ArcRunner.start()` must be idempotent by `input.run_id`: retrying after a crash
returns the same durable handle and must not create a second underlying run.
Control methods are idempotent and return the underlying state (`running`,
`paused`, `finished`, or `cancelled`). If completion races with pause or cancel,
they return `finished`; ARC validates the artifact and records its real terminal
status.

`collect()` has one active call per run in a coordinator process. It stays
pending while a run is paused, continues after resume, and returns `finished`
only after the output artifact has been atomically written. After process
restart, ARC awaits recovery before connecting MCP: queued rows retry
`start(run_id)`, while running handles are actively paused through the runner
before the database is marked `restart_recovered`. Recovery failures remain
visible in the run phase and error fields.

The runner adapter shares the MCP server process. It must never write logs or
diagnostics to stdout, because stdout carries the stdio MCP protocol. Write
diagnostics to stderr or a file instead.

MetaBot release packages include and build this workspace, but the installer
does not start or register the MCP server. Supplying the trusted scope and
runner adapter remains an explicit integration step.

## Development

```bash
npm run build -w @xvirobotics/arc-mcp
npm test -w @xvirobotics/arc-mcp
npm run typecheck -w @xvirobotics/arc-mcp
npm run lint -w @xvirobotics/arc-mcp
```
