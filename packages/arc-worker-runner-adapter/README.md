# ARC Worker Runner adapter

`@xvirobotics/arc-worker-runner-adapter` implements the independent ARC
`ArcRunner` interface over the Worker Runner MCP wire. Production source has no
runtime import of Worker Runner, Bridge, Memory, WorkerManager, Agent Team, or
an engine-specific SDK. Worker Runner is a development-only dependency used by
wire integration tests.

## Execution mapping

For input run `project_id=P`, `run_id=R`, `start()` calls `worker_dispatch`
with deterministic key `arc:v1:<url-encoded-P>:<url-encoded-R>`. It declares:

- `retry_terminal: false` and `dedupe_ttl_ms: 0`, which permanently reuses the
  terminal worker for that ARC run;
- `{ restart: "manual", idempotent: false }`, so a daemon restart never blindly
  relaunches an ambiguous one-shot research process;
- `workdir = project_root`, bounded wall/no-output timeouts, and a generic JSON
  output declaration;
- a prompt rendered only from the validated versioned ARC input. No process
  environment, callback key, capability, proxy endpoint, or other daemon
  configuration is interpolated.

Worker states map as follows:

| Worker Runner | ARC runner |
| --- | --- |
| `queued`, `running` | `running` |
| `completed`, `failed`, `timed_out` | `finished` (ARC validates the artifact) |
| `aborted` | `cancelled` |
| `recovery_required` | `runner_failure`; explicit PM/operator action required |

`collect()` polls durable `worker_status`, so another ARC daemon process can
reattach to the same handle. `cancel()` uses idempotent `worker_abort`. A
one-shot CLI has no checkpoint, so pause is explicitly unsupported while it is
live; terminal races return the actual terminal mapping. `resume()` only reads
the current durable worker state.

The job must atomically write `autoresearchclaw.output.v2` to the input's
project-relative `artifact_path`. The adapter neither scans artifacts nor
promotes memory; validation and lifecycle ownership stay in ARC.

## Configuration

The ARC daemon loads this package as its runner module. The trusted daemon
process supplies:

```text
METABOT_ARC_WORKER_ENDPOINT=http://127.0.0.1:9311/mcp
METABOT_ARC_WORKER_CAPABILITY_FILE=/absolute/private/arc-service.cap
METABOT_ARC_WORKER_ENGINE=codex
METABOT_ARC_WORKER_MODEL=gpt-5.4
METABOT_ARC_WORKER_TIMEOUT_MS=14400000
METABOT_ARC_WORKER_IDLE_TIMEOUT_MS=1800000
METABOT_ARC_WORKER_POLL_MS=5000
```

The service capability file must be a regular non-symlink file inaccessible to
group/other users. Its Worker Runner principal should use the dedicated
`arc-service` scope; direct chat-scoped Worker tools then cannot see or abort
ARC's internal workers.

## Phase B integration still required

This package does not issue capabilities, receive callbacks, supervise the two
daemons, or write engine MCP configuration. Those Bridge responsibilities wait
for the W01 governance capability work and belong to Phase B. A symmetric HMAC
capability key places Bridge and both trusted daemons in one host trust domain:
any holder of that key can mint as well as verify capabilities.

## Development

```bash
npm run build -w @xvirobotics/arc-worker-runner-adapter
npm run typecheck -w @xvirobotics/arc-worker-runner-adapter
npm run lint -w @xvirobotics/arc-worker-runner-adapter
npm test -w @xvirobotics/arc-worker-runner-adapter
```

Tests use the real W05 MCP protocol server with a fake process runner. They
cover prompt hygiene, durable dedupe, queued crash recovery, output collection,
cancel, honest pause behavior, wire validation, and forbidden imports.
