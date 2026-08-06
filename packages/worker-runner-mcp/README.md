# MetaBot Worker Runner MCP

`@xvirobotics/worker-runner-mcp` is an independent MCP server for durable,
one-shot Codex, Claude, or Kimi CLI jobs. `worker_dispatch` persists a `queued`
record before process creation and returns without waiting for the CLI task to
finish.

This package is intentionally independent. It does not import or call the
MetaBot Bridge, BotRegistry, Agent Team store/supervisor, the former Worker
Manager, Research Memory, or AutoResearchClaw. It is not wired into Bridge
engine configuration.

## Components

- `WorkerStore`: exclusive data-directory ownership plus SQLite lifecycle,
  quota, dedupe, process result, recovery, and notification delivery state.
- `ProcessRunner`: injectable process interface; `NodeCliProcessRunner` is the
  one-shot CLI implementation.
- `WorkerService`: pinned authority, validation, lifecycle, timeout, abort,
  restart reconciliation, and callback coordination.
- `CompletionNotifier`: injected callback interface; the HTTP adapter uses a
  stable idempotency key.
- `createWorkerRunnerMcpServer`: MCP protocol adapter with bounded responses.
- `metabot-worker-runner-mcp`: standalone, environment-pinned stdio executable.
- `metabot-worker-runnerd`: long-lived, authenticated loopback HTTP daemon.
- `metabot-worker-runner-proxy`: thin stdio-to-local-HTTP relay.

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

Construction fails closed if the principal is missing or incomplete, or uses
a `team:*` chat. The tool schemas contain no
`actor_role`, `caller_context`, `botName`, `chatId`, or `pmChatId` fields, and
unexpected arguments are rejected.

Dispatch always uses the authenticated bot+chat scope. `admin`, `user`, and
`pm` may dispatch or abort; `manager`, `agent`, and `worker` are read-only.
A non-admin can list or read only its own scope. An admin may request an
all-scope list and control another scope; model arguments cannot create admin
authority.

### Daemon sessions and capabilities

The daemon accepts only loopback HTTP and requires a signed Bearer capability
before it creates an MCP session. It verifies the capability again on every
request and rejects a token whose principal differs from the one bound during
initialization. Missing, expired, malformed, wrong-purpose, and cross-session
capabilities fail closed. The frozen token is
`base64url(JSON claims).base64url(Ed25519 signature)`; its exact claims are
`{v:1,purpose:'worker',role,botName,chatId,exp}`. The daemon receives only the
current capability public key plus an optional previous public key during
rotation (`<current>.prev` is discovered automatically). Capability and
callback key files must be bounded regular,
non-symbolic-link Ed25519 PEM files with no group/other permissions.

The capability that established a session is saved privately with each new
job for terminal callback authorization. It is never returned by list/status,
placed in tool schemas, or copied into a Worker child environment. Callback
signing uses a distinct daemon-private Ed25519 key. These controls provide
scope hygiene and prevent accidental cross-chat use. They are not containment
against malicious code running as the same OS user, which can read or replace
host key and state files; that requires OS-user separation.

The proxy receives its capability only through
`METABOT_WORKER_PROXY_CAPABILITY` (or a private token file), puts it in the
local HTTP Authorization header, and forwards JSON-RPC unchanged. It never
adds identity fields to tool calls. The standalone stdio executable keeps the
existing environment-pinned identity mode.

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
contract from prompt wording. When an optional `model`, `label`, `dedupe_key`,
or output-contract `description` is supplied, it must contain non-whitespace
text; an empty value is rejected rather than silently treated as absent.

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
- a completed result is reused within `dedupe_ttl_ms` when terminal retries are
  enabled;
- `failed`, `aborted`, `timed_out`, and `recovery_required` work is retried by
  default;
- when `retry_terminal` is explicitly false, every terminal result is reused
  permanently for that key. This is the durable idempotence mode used by ARC.

Each job has a bounded wall timeout and no-output timeout. Defaults are one hour
and ten minutes, so silent work cannot occupy quota forever. Activity on stdout
or stderr refreshes the no-output timer.

## Process behavior and environment

- Codex: `codex exec --json ... -`, with the prompt on stdin.
- Claude: `claude --print --output-format text`, with the prompt on stdin.
- Kimi: `kimi --prompt ... --output-format text`. No safe stdin or prompt-file
  mode has been verified for the supported CLI, so the fully rendered prompt
  is rejected above 16,384 UTF-8 bytes before it is persisted. The process
  adapter repeats the check before spawn to prevent `E2BIG` argument overflow.

The canonical absolute `workdir` is the child working directory. Codex defaults
to the `workspace-write` sandbox and `never` approval policy. A working
directory or CLI permission mode is not an operating-system isolation boundary;
use host-level containment for untrusted tasks.

The child does not inherit the parent environment. It receives a small default
set needed by interactive CLIs, such as `PATH`, locale, home, temp, and CLI
config directories. `METABOT_WORKER_ENV_ALLOWLIST` may add safe variable names.
Names that look like API, admin, auth, callback, capability, principal, token,
password, cookie, session, credential, or private/access-key values are always
rejected, even if added to the allowlist. Worker Runner configuration and
proxy-secret variables such as `HTTP_PROXY_PASSWORD` are also never forwarded.

Ordinary proxy routing variables are not secrets by name and can be explicitly
enabled in production:

```bash
METABOT_WORKER_ENV_ALLOWLIST=HTTP_PROXY,HTTPS_PROXY,http_proxy,https_proxy,NO_PROXY,no_proxy
```

They remain opt-in because their values are visible to the child and proxy URLs
can themselves contain credentials. Operators should use credential-free URLs
where possible and never encode secrets into an allowlisted variable.

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

An idempotent relaunch does not prove that the previous process exited. The old
launch may still be running while the replacement starts, so `idempotent: true`
must mean concurrent duplicate execution and repeated external side effects are
safe. Use the default manual policy when that cannot be guaranteed.

## Exclusive data-directory ownership

Only one Worker Runner process may open a data directory. `WorkerStore` creates
`.worker-runner.lock` with an exclusive filesystem operation before SQLite is
opened. The lock records an instance ID, process ID, hostname, and start time.

- A second live local owner fails startup with `DATA_DIR_LOCKED`.
- A verifiably dead local owner is renamed to a timestamped stale-lock
  diagnostic before startup continues. The stdio executable reports that path
  on stderr.
- An owner on another host, an unreadable lock, a symlink, or malformed owner
  metadata is unverifiable and fails closed; it is never removed automatically.
- A clean `WorkerStore.close()` removes only its own matching lock. A crash
  leaves enough owner metadata for safe stale recovery on the next start.

Use one long-lived daemon or stdio instance per data directory. Separate
instances require separate `METABOT_WORKER_DATA_DIR` values.

## Completion callback

In authenticated daemon mode, set `METABOT_WORKER_CALLBACK_URL` and
`METABOT_WORKER_CALLBACK_PRIVATE_KEY_FILE` to enable HTTP completion posts. The
prompt is omitted. The signed `metabot.terminal-callback.v1` envelope contains
the event, bot/chat scope, terminal status, numeric epoch-ms finish time, issue
time, original `authorizing_capability`, and bounded worker payload. Its stable
event ID is `worker:<id>:terminal:v1`, sent in the body and the
`Idempotency-Key` header. `X-MetaBot-Callback-Signature` is
`ed25519:<base64>` over the exact raw body bytes.

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
| `METABOT_WORKER_DATA_DIR`                | `~/.metabot/worker-runner` | Exclusively owned state/SQLite directory   |
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
| `METABOT_WORKER_CALLBACK_PRIVATE_KEY_FILE` | required with callback URL | Daemon-private Ed25519 callback key file  |
| `METABOT_WORKER_CALLBACK_TIMEOUT_MS`     | `30000`                    | Callback request timeout                   |
| `METABOT_WORKER_NOTIFY_RETRY_INITIAL_MS` | `1000`                     | First notification retry delay             |
| `METABOT_WORKER_NOTIFY_RETRY_MAX_MS`     | `60000`                    | Maximum notification retry delay           |
| `METABOT_WORKER_LISTEN`                  | daemon: required           | Loopback HTTP MCP URL, including `/mcp`     |
| `METABOT_WORKER_CAPABILITY_PUBLIC_KEY_FILE` | daemon: required        | Bridge capability Ed25519 public key      |
| `METABOT_WORKER_CAPABILITY_PREVIOUS_PUBLIC_KEY_FILE` | `<current>.prev` if present | Optional previous public key during rotation |
| `METABOT_WORKER_MAX_REQUEST_BYTES`       | 1 MiB                      | Daemon request-body bound                   |
| `METABOT_WORKER_PROXY_ENDPOINT`          | proxy: required            | Daemon loopback MCP URL                     |
| `METABOT_WORKER_PROXY_CAPABILITY`        | proxy: required*           | Session capability from trusted spawn env   |
| `METABOT_WORKER_PROXY_CAPABILITY_FILE`   | proxy: optional*           | Private capability token file alternative   |

`*` Configure exactly one capability source for the proxy. All daemon and
proxy diagnostics go to stderr; stdout is reserved exclusively for stdio MCP
JSON-RPC framing.

## Build and test

From the repository root:

```bash
npm run build -w @xvirobotics/worker-runner-mcp
npm test -w @xvirobotics/worker-runner-mcp
```

The package requires Node 22.19 or newer.

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
