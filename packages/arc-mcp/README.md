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
    "METABOT_ARC_RUNNER_MODULE": "/absolute/path/to/runner-adapter.js"
  }
}
```

The runner module must export `createArcRunner()`. Its returned object implements
`start`, `pause`, `resume`, `cancel`, and `collect`. The runner handle must be a
JSON-safe object with an `id`, so a paused run can survive MCP process restart.
`METABOT_ARC_DATA_DIR` is required; the server never defaults state into the
repository or a broad shared directory.

## Development

```bash
npm run build -w @xvirobotics/arc-mcp
npm test -w @xvirobotics/arc-mcp
npm run typecheck -w @xvirobotics/arc-mcp
```
