# MetaBot Worker Runner MCP

`@xvirobotics/worker-runner-mcp` is a standalone stdio MCP server for durable,
one-shot Codex, Claude, or Kimi CLI jobs. `worker_dispatch` persists a `queued`
record before process creation and returns without waiting for the CLI task to
finish.

This package is intentionally independent. It does not import or call the
MetaBot Bridge, BotRegistry, Agent Team store/supervisor, the former Worker
Manager, Research Memory, or AutoResearchClaw. It is not wired into Bridge
engine configuration.

## Components

- `WorkerStore`: SQLite lifecycle, quota, dedupe, process result, recovery, and
  notification delivery state.
- `ProcessRunner`: injectable process interface; `NodeCliProcessRunner` is the
  one-shot CLI implementation.
- `WorkerService`: pinned authority, validation, lifecycle, timeout, abort,
  restart reconciliation, and callback coordination.
- `CompletionNotifier`: injected callback interface; the HTTP adapter uses a
  stable idempotency key.
- `createWorkerRunnerMcpServer`: MCP protocol adapter with bounded responses.
- `metabot-worker-runner-mcp`: standalone stdio executable.

Tests use fake process and callback adapters. They do not invoke an agent CLI
or HTTP service.

## Trusted principal and scope

Authority never comes from model-controlled tool arguments. The embedding
process must pin one trusted principal when it creates the runtime or MCP
server:

```ts
createWorkerRunnerRuntime({
  principal: { role: 'pm', botName: 'research-pm', chatId: 'oc_example' },
});
```

The stdio executable reads the same identity from these required environment
variables:

- `METABOT_WORKER_PRINCIPAL_ROLE`: `admin`, `user`, or `pm`
- `METABOT_WORKER_PRINCIPAL_BOT_NAME`
- `METABOT_WORKER_PRINCIPAL_CHAT_ID`

Construction fails closed if the principal is missing, incomplete, has a role
outside `admin|user|pm`, or uses a `team:*` chat. The tool schemas contain no
`actor_role`, `caller_context`, `botName`, `chatId`, or `pmChatId` fields, and
unexpected arguments are rejected.

Dispatch always uses the pinned bot+chat scope. A non-admin principal can only
list, read, abort, reconcile, and notify jobs in that scope. A pinned admin may
request an all-scope list and may read or abort another scope; model arguments
cannot create admin authority.

## MCP tools

The server advertises exactly four tools:

- `worker_dispatch`: persist and asynchronously launch one CLI job.
- `worker_list`: return bounded job summaries in the pinned scope; a pinned
  admin may set `all_scopes`.
- `worker_status`: return one bounded lifecycle/result record.
- `worker_abort`: abort queued or currently owned running work. Repeating an
  abort after terminal state is safe.

Example dispatch arguments:

```json
{
  "workdir": "/absolute/path/to/project",
  "prompt": "Run the focused benchmark and report the result.",
  "engine": "codex",
  "model": "gpt-5.4",
  "dedupe_key": "benchmark-2026-08-06",
  "dedupe_ttl_ms": 86400000,
  "retry_terminal": true,
  "timeout_ms": 1800000,
  "idle_timeout_ms": 300000,
  "recovery_policy": {
    "restart": "manual",
    "idempotent": false
  },
  "output_contract": {
    "format": "json",
    "description": "Return metric names, values, and caveats.",
    "json_schema": {
      "type": "object"
    }
  }
}
```

The generic output contract is only forwarded as final-response instructions.
The runner never scans the workdir, interprets artifact names, or infers a
contract from prompt wording.

## Lifecycle, quota, and dedupe

Durable states are `queued`, `running`, `completed`, `failed`, `timed_out`,
`aborted`, and `recovery_required`.

SQLite inserts `queued` before spawn. The record becomes `running` only after
the current process runner returns a PID and the service writes a fresh launch
identity. Terminal transitions must match that launch identity, so late
completion cannot overwrite an abort or timeout.

The per-bot+chat concurrency quota atomically counts both `queued` and
`running`. Dedupe is evaluated before the quota:

- `queued` and `running` work with the same key is always reused;
- a completed result is reused only within `dedupe_ttl_ms`;
- `failed`, `aborted`, `timed_out`, and `recovery_required` work is retried by
  default, or reused when `retry_terminal` is explicitly false.

Each job has a bounded wall timeout and no-output timeout. Defaults are one hour
and ten minutes, so silent work cannot occupy quota forever. Activity on stdout
or stderr refreshes the no-output timer.

## Process behavior and environment

- Codex: `codex exec --json ... -`, with the prompt on stdin.
- Claude: `claude --print --output-format text`, with the prompt on stdin.
- Kimi: `kimi --prompt ... --output-format text`.

The canonical absolute `workdir` is the child working directory. Codex defaults
to the `workspace-write` sandbox and `never` approval policy. A working
directory or CLI permission mode is not an operating-system isolation boundary;
use host-level containment for untrusted tasks.

The child does not inherit the parent environment. It receives a small default
set needed by interactive CLIs, such as `PATH`, locale, home, temp, and CLI
config directories. `METABOT_WORKER_ENV_ALLOWLIST` may add safe variable names.
Names that look like API, auth, token, password, callback, cookie, session,
credential, or private/access-key values are always rejected, even if added to
the allowlist. Worker Runner configuration and callback variables are also
never forwarded.

Stdout and stderr are stored separately and bounded by
`METABOT_WORKER_MAX_OUTPUT_BYTES` per stream. Terminal records include exit
code, signal, reason, bounded output/error, truncation flags, timestamps, and
duration. `worker_list` never returns prompts or process output;
`worker_status` applies a second read bound. Prompts remain in private SQLite
state because an explicitly recoverable job needs them.

## Restart reconciliation and abort safety

Recovery is declared per dispatch. There is no global blind-recovery switch.

- `{ "restart": "manual", "idempotent": false }` is the default. After a
  server restart, a persisted `queued` or `running` job becomes
  `recovery_required` and is not relaunched.
- `{ "restart": "relaunch", "idempotent": true }` permits relaunch of the same
  durable job after restart. The launch and recovery counters increase.
- `restart: "relaunch"` is rejected unless `idempotent` is true.

The new server never treats a numeric PID from SQLite as proof of process
identity. It does not inspect, adopt, or signal that PID. `worker_abort` signals
only a child held in the current process runner's active map with the matching
launch identity. An ambiguous persisted running job becomes
`recovery_required` instead.

## Completion callback

Set `METABOT_WORKER_CALLBACK_URL` to enable HTTP completion posts. The payload
omits the prompt. Its stable event ID is `worker:<id>:terminal:v1`, sent in the
body and the `Idempotency-Key` header.

Notification state, attempt count, next retry deadline, last error, and
delivery time are durable. Failures use bounded exponential backoff and an
in-process timer; startup resumes pending deadlines and resets an interrupted
`sending` attempt. A crash after remote success but before the local SQLite
commit can still cause an at-least-once retry, so receivers must dedupe the
stable event ID.

## Configuration

| Environment variable                     | Default                    | Meaning                                    |
| ---------------------------------------- | -------------------------- | ------------------------------------------ |
| `METABOT_WORKER_PRINCIPAL_ROLE`          | required                   | Pinned `admin`, `user`, or `pm` role       |
| `METABOT_WORKER_PRINCIPAL_BOT_NAME`      | required                   | Pinned bot scope                           |
| `METABOT_WORKER_PRINCIPAL_CHAT_ID`       | required                   | Pinned non-Team chat scope                 |
| `METABOT_WORKER_DATA_DIR`                | `~/.metabot/worker-runner` | Directory containing `workers.sqlite`      |
| `METABOT_WORKER_MAX_PER_SCOPE`           | `4`                        | `queued` + `running` quota per bot+chat    |
| `METABOT_WORKER_DEFAULT_TIMEOUT_MS`      | 1 hour                     | Default wall timeout                       |
| `METABOT_WORKER_DEFAULT_IDLE_TIMEOUT_MS` | 10 minutes                 | Default no-output timeout                  |
| `METABOT_WORKER_MAX_TIMEOUT_MS`          | 7 days                     | Maximum accepted wall timeout              |
| `METABOT_WORKER_MAX_IDLE_TIMEOUT_MS`     | 1 day                      | Maximum accepted no-output timeout         |
| `METABOT_WORKER_DEDUPE_TTL_MS`           | 1 day                      | Default completed-result reuse period      |
| `METABOT_WORKER_MAX_DEDUPE_TTL_MS`       | 30 days                    | Maximum completed-result reuse period      |
| `METABOT_WORKER_MAX_LIST_LIMIT`          | `100`                      | Maximum list result count                  |
| `METABOT_WORKER_STATUS_OUTPUT_CHARS`     | `16384`                    | Read bound for each status output stream   |
| `METABOT_WORKER_MAX_OUTPUT_BYTES`        | 1 MiB                      | Stored bytes per stdout/stderr stream      |
| `METABOT_WORKER_ENV_ALLOWLIST`           | unset                      | Extra comma-separated safe child variables |
| `METABOT_WORKER_KILL_GRACE_MS`           | `2000`                     | SIGTERM grace period before SIGKILL        |
| `METABOT_WORKER_CODEX_EXECUTABLE`        | `codex`                    | Codex CLI path                             |
| `METABOT_WORKER_CLAUDE_EXECUTABLE`       | `claude`                   | Claude CLI path                            |
| `METABOT_WORKER_KIMI_EXECUTABLE`         | `kimi`                     | Kimi CLI path                              |
| `METABOT_WORKER_CALLBACK_URL`            | unset                      | Terminal callback URL                      |
| `METABOT_WORKER_CALLBACK_TOKEN`          | unset                      | Optional callback bearer token             |
| `METABOT_WORKER_CALLBACK_TIMEOUT_MS`     | `30000`                    | Callback request timeout                   |
| `METABOT_WORKER_NOTIFY_RETRY_INITIAL_MS` | `1000`                     | First notification retry delay             |
| `METABOT_WORKER_NOTIFY_RETRY_MAX_MS`     | `60000`                    | Maximum notification retry delay           |

## Build and test

From the repository root:

```bash
npm run build -w @xvirobotics/worker-runner-mcp
npm test -w @xvirobotics/worker-runner-mcp
```

Example MCP configuration after building:

```json
{
  "mcpServers": {
    "worker-runner": {
      "command": "node",
      "args": ["/path/to/metabot/packages/worker-runner-mcp/dist/cli.js"],
      "env": {
        "METABOT_WORKER_DATA_DIR": "/path/to/private/state",
        "METABOT_WORKER_PRINCIPAL_ROLE": "pm",
        "METABOT_WORKER_PRINCIPAL_BOT_NAME": "research-pm",
        "METABOT_WORKER_PRINCIPAL_CHAT_ID": "oc_example"
      }
    }
  }
}
```
