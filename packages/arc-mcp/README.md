# AutoResearchClaw MCP

`@xvirobotics/arc-mcp` is an independent AutoResearchClaw (ARC) lifecycle
service. It owns versioned input, output, and run contracts, project-local
artifacts, durable SQLite run state, and six MCP tools:

- `arc_run_start`
- `arc_run_get`
- `arc_run_list`
- `arc_run_pause`
- `arc_run_resume`
- `arc_run_cancel`

The package does not import MetaBot Bridge, Memory Core, Wiki ingest,
WorkerManager, Agent Team, or engine-specific code. It never promotes a result
to memory. A runner is supplied through the small `ArcRunner` interface; the
independent `@xvirobotics/arc-worker-runner-adapter` implements it over the
Worker Runner MCP wire. A future Memory MCP may consume the validated output
through the separate `ArcResultConsumer` interface.

It ships three executables: `metabot-arc-mcp` keeps the original standalone
stdio mode; `metabot-arcd` is the long-lived authenticated loopback daemon; and
`metabot-arc-proxy` is a thin stdio relay for one engine session.

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
`start`, `recover`, `pause`, `resume`, `cancel`, and `collect`. The runner handle
must be a JSON-safe object with an `id`, so a live run can survive MCP process
restart.
`METABOT_ARC_DATA_DIR` is required; the server never defaults state into the
repository or a broad shared directory.

`METABOT_ARC_PROJECT_ROOTS` is also required and must be a non-empty JSON array.
The server canonicalizes each root and matches it exactly. It will not start,
list, read, pause, resume, or cancel runs outside those roots. Set
`METABOT_ARC_PROJECT_ID` to bind the server to one project ID as well. A missing
root policy fails server startup instead of accepting arbitrary directories.

## Daemon authority and origin

`metabot-arcd` accepts only loopback HTTP. It verifies a signed Bearer
capability before MCP initialization, binds its role/bot/chat principal to that
session, and verifies both capability validity and the same principal on every
later request. Tool schemas remain identity-free. Missing, expired,
wrong-purpose, malformed, or session-rebinding capabilities fail closed.

`admin`, `user`, and `pm` may start, pause, resume, or cancel runs.
`manager`, `agent`, and `worker` are read-only. A trusted principal's bot and
chat are saved as the run's `originator` when `arc_run_start` creates it; those
values never come from tool arguments. Project ID/root restrictions remain the
separate trusted server policy described above.

Capabilities use the frozen v2.1 Ed25519 form
`base64url(JSON claims).base64url(signature)` with exact claims
`{v:1,purpose:'arc',role,botName,chatId,exp}`. The daemon holds the current
capability public key and may also accept one previous public key during
rotation (`<current>.prev` is discovered automatically); it signs callbacks
with a distinct daemon-private Ed25519 key. Key
files are bounded regular non-symlink PEM files inaccessible to group/other
users.

The session-establishing capability is stored privately alongside originator
metadata so a terminal callback can prove its bot/chat authorization. It is
never exposed in run status/list/tool output or passed to a runner. These
controls provide scope hygiene, not containment against malicious same-UID
code; host-user separation is required for that stronger boundary.

Example daemon configuration:

```text
METABOT_ARC_DATA_DIR=/absolute/private/state
METABOT_ARC_PROJECT_ROOTS=["/absolute/project/root"]
METABOT_ARC_RUNNER_MODULE=/absolute/path/to/runner-adapter.js
METABOT_ARC_LISTEN=http://127.0.0.1:9312/mcp
METABOT_ARC_CAPABILITY_PUBLIC_KEY_FILE=/absolute/private/arc-capability.pub
METABOT_ARC_CAPABILITY_PREVIOUS_PUBLIC_KEY_FILE=/absolute/private/arc-capability.pub.prev
METABOT_ARC_CALLBACK_URL=http://127.0.0.1:9100/api/worker-events
METABOT_ARC_CALLBACK_PRIVATE_KEY_FILE=/absolute/private/arc-callback.key
```

The proxy receives its capability only through
`METABOT_ARC_PROXY_CAPABILITY` (or a private capability file) and supplies it
only in the local HTTP Authorization header:

```text
METABOT_ARC_PROXY_ENDPOINT=http://127.0.0.1:9312/mcp
METABOT_ARC_PROXY_CAPABILITY=<short-lived session token>
```

All daemon and proxy diagnostics go to stderr. Stdout is reserved exclusively
for stdio MCP JSON-RPC framing.

Only one server process may own a data directory. ARC holds an exclusive lock
containing the process ID, host, instance ID, and start time. A second live
owner fails startup. A verifiably dead owner is archived as a stale-lock
diagnostic before recovery continues; an owner on another host is treated as
unverifiable and is never removed automatically.

## Runner lifecycle contract

`ArcRunner.start()` must be idempotent by `input.run_id`: retrying after a crash
returns the same durable handle and must not create a second underlying run.
`ArcRunner.recover()` is a read-only durable-handle probe. It must not launch,
pause, resume, or otherwise alter the underlying run, and it fails closed if it
cannot prove the handle still identifies that run.
Control methods are idempotent and return the underlying state (`running`,
`paused`, `finished`, or `cancelled`). If completion races with pause or cancel,
they return `finished`; ARC validates the artifact and records its real terminal
status.

`collect()` has one active call per run in a coordinator process. It stays
pending while a run is paused, continues after resume, and returns `finished`
only after the output artifact has been atomically written. After process
restart, ARC awaits recovery before connecting MCP: queued rows retry
`start(run_id)`, while running handles use `recover(handle)` to reattach and
resume collection without relaunching or changing the underlying execution.
Recovery failures remain visible in the run phase and error fields.

The runner adapter shares the MCP server process. It must never write logs or
diagnostics to stdout, because stdout carries the stdio MCP protocol. Write
diagnostics to stderr or a file instead.

## Terminal callback

For authenticated daemon starts, ARC durably records a pending terminal
notification. A separate notifier observes terminal rows; the coordinator does
not infer callback targets or perform network calls. The signed
`metabot.terminal-callback.v1` envelope uses stable event ID
`arc:<run-id>:terminal:v1`, includes the authenticated bot/chat scope, and sends
the same ID in `Idempotency-Key`. It also includes numeric epoch-ms
`finished_at` and the original `authorizing_capability` inside the signed body.
`X-MetaBot-Callback-Signature` is `ed25519:<base64>` over the exact raw body.
Delivery is at least once: retry state and backoff deadlines are stored in
SQLite, and a restarted notifier resumes them. Receivers must verify the raw
body signature, match the capability and envelope bot/chat scope, and durably
deduplicate the event ID.

If no callback URL is configured, no notification worker starts; originator
metadata remains durable for a later correctly configured restart. ARC still
does not promote or ingest memory automatically.

MetaBot release packages build this workspace and register `metabot-arcd` as a
PM2 sibling of Bridge and Worker Runner. Production configuration supplies the
trusted project roots; the safe default is the dedicated
`~/.metabot/arc-projects` directory. The daemon loads the packaged runner
adapter, and lifecycle health uses an authenticated read-only MCP call. Engine
session materialization remains a separate, default-off integration.

## Development

```bash
npm run build -w @xvirobotics/arc-mcp
npm test -w @xvirobotics/arc-mcp
npm run typecheck -w @xvirobotics/arc-mcp
npm run lint -w @xvirobotics/arc-mcp
```
