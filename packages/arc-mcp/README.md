# AutoResearchClaw MCP

`@xvirobotics/arc-mcp` is an independent AutoResearchClaw (ARC) lifecycle
service. It owns versioned input, output, and run contracts, project-local
artifacts, durable SQLite run state, official external execution, and eight MCP
tools:

- `arc_run_start`
- `arc_run_get`
- `arc_run_list`
- `arc_run_pause`
- `arc_run_resume`
- `arc_run_cancel`
- `arc_hitl_submit`
- `arc_run_manifest`

The package does not import MetaBot Bridge, Memory Core, Wiki ingest,
WorkerManager, Agent Team, or engine-specific code, and it does not depend on
MetaClaw or on any unified research gateway. It never promotes a result to
memory. A future Memory MCP may consume the validated output through the
separate `ArcResultConsumer` interface.

The production runner is `OfficialArcDriver`, which re-verifies a sealed
official release and then delegates to a detached process supervisor. The small
`ArcRunner` interface remains the only execution seam, so tests and an
operator-pinned experiment can supply their own implementation through
`METABOT_ARC_RUNNER_MODULE`. There is no silent fallback: if a release root is
configured and its release does not verify, the run fails.

It ships five executables: `metabot-arc-mcp` keeps the original standalone
stdio mode; `metabot-arcd` is the long-lived authenticated loopback daemon;
`metabot-arc-proxy` is a thin stdio relay for one engine session;
`metabot-arc-supervisor` is the detached official run owner; and
`metabot-arc-release` is a read-only release doctor and selector planner.

## Official AutoResearchClaw execution

Official AutoResearchClaw stays an independently installed application outside
this repository. ARC records the exact revision it is paired with and refuses to
launch anything else. Two pins exist side by side:

- MCP execution is pinned to `v0.5.0-45` (`e2e23c9`), the commit the
  `python/official_compat.py` shims were audited against.
- Direct shell use is pinned to the exact published `v0.5.0` tag.

They resolve to different release ids, so both can be sealed under one release
root without either being presented as the other. The current MCP execution pin
is append-only v2,
`0.5.0-e2e23c93b494-arc-mcp-0.3.0-v2`; it supersedes the historical
source-only `0.5.0-e2e23c93b494-arc-mcp-0.3.0` pairing without editing it.

Before every official launch, ARC re-verifies the pinned origin, exact revision,
detached and clean checkout, source-tree hash, dependency-freeze digest,
downstream compatibility probe, and the version of the mutable global `acpx`
install. `acpx` lives outside every sealed release, so it is the one pinned
dependency that can drift between two otherwise identical runs and is therefore
checked on the launch path rather than only at seal time.

```text
METABOT_ARC_RELEASE_ROOT=/absolute/path/to/research-stack/autoresearchclaw
METABOT_ARC_OFFICIAL_HITL_MODE=gate-only
METABOT_ARC_OFFICIAL_ACP_AGENT=codex
```

The official pipeline outlives the daemon by design, so the authority is a
detached supervisor process plus its atomic on-disk state, not an in-memory
child handle. The supervisor runs in its own process group, which is what makes
group-wide pause, resume, and cancel safe, and it publishes exactly one terminal
artifact. A coordinator restart re-attaches through the state file alone.

### Immutable releases

A sealed release's source *and* virtualenv are made recursively read-only at
install time. Sealing only the source left the half that actually executes —
every third-party package, every console script and the editable install of the
source itself — writable by the same user that runs the daemon, so a stray
`pip install` could change what the release executes while every identity the
manifest records still matched.

Read and execute bits are preserved exactly, so a sealed console script is still
an executable console script; only write permission is dropped. The install
proves it: the structural probe is re-run through the sealed interpreter and
`researchclaw --help` is executed from the sealed virtualenv before the manifest
is written, so an install that sealed a release into something unusable fails
instead of being recorded.

The manifest records the census that sealing produced, and both trees are
re-walked before every launch. Verification fails closed on a writable file or
directory, on any symlink other than a virtualenv's own `bin/python*`
interpreter links, on a node that is neither a file nor a directory, and on a
census that no longer matches. A bounded run additionally refuses any release
that is not sealed this way: a guard living in a writable tree bounds nothing.

Releases sealed before this existed carry no immutability block. That absence is
reported rather than repaired — their permissions are part of the evidence they
are — so they stay verifiable as rollback assets while being ineligible for
installation, launch, current selection, or a bounded run once a replacement is
pinned.

### Sealed release provenance

Sealed manifests are append-only evidence, never configuration. A package
rename or a correction produces a new release id; the old manifest stays intact
so it remains a usable rollback asset. Manifests sealed by the retired
`@xvirobotics/arc-researchclaw-adapter` or by the rejected unified
`@xvirobotics/research-stack-mcp` are accepted by exact identity and reported as
`superseded` rather than rewritten, and a superseded pairing never claims that
this driver's bridge revision sealed the release.

`metabot-arc-release doctor` reports the sealed releases, the current selector,
both pins, and whether the paired release still verifies.
`metabot-arc-release selector-plan [path]` prints the exact `researchclaw`
selector script it would write, without touching the filesystem. Installing a
release and installing a selector are operator actions: neither the daemon nor
any MCP tool performs them.

The public install pins are `mcp-execution` and `hard-budget-candidate`. Both
create new recursively sealed v2 releases. The latter is explicitly unofficial
and resolves to
`unofficial-0.5.0-8fa6d66d1b8f-hard-budget-guard-v2`; its manifest carries
`official: false`, its exact patch series, and a machine-readable `supersedes`
record naming the already installed source-only candidate. The historical
`mcp-execution-v1` and `hard-budget-candidate-v1` names are verification-only:
install, launch, bounded selection, and production-current selection fail
closed, while `verify` continues to validate their recorded bytes and hashes.

```bash
METABOT_ARC_BOOTSTRAP_PYTHON=/opt/homebrew/bin/python3.11 \
  metabot-arc-release install mcp-execution
METABOT_ARC_BOOTSTRAP_PYTHON=/opt/homebrew/bin/python3.11 \
  metabot-arc-release install hard-budget-candidate \
  --patch-source /absolute/path/to/autoresearchclaw-cost-guard
metabot-arc-release verify mcp-execution
metabot-arc-release verify hard-budget-candidate
```

These commands do not write the production `current` selector or the direct
`researchclaw` selector. Repeating an install for the same release id performs
verification and returns the existing manifest without changing its bytes.

The generated selector is a plain POSIX script that `exec`s the release's own
console entry point. It contains no Node, no MetaBot path, no daemon URL, and no
capability, so `researchclaw` keeps working with every MetaBot and MCP process
stopped. Selecting a release never starts, configures, or activates anything.

### Human-in-the-loop gates

Official AutoResearchClaw owns `run_dir/hitl/waiting.json` and consumes
`run_dir/hitl/response.json`. ARC's MCP surface owns
`.metabot-arc/runs/<run>/hitl/<request>.request.json` and its `.response.json`
sibling. The detached supervisor is the only writer that bridges them, so
neither side learns the other's schema and no gate decision is invented by this
package. One official gate maps to exactly one request id derived from the
gate's own identity, so a supervisor restart republishes the same id instead of
opening a second gate. `arc_hitl_submit` records one decision; submitting twice
for the same gate is a conflict, not a silent overwrite.

### Result provenance

`arc_run_manifest` returns a provenance-first manifest plus the gates still
awaiting a decision. It claims `official_external_cli` only when a sealed
release manifest proved the exact pinned revision drove that run; otherwise the
execution path is `unproven` with an explicit fallback reason. Semantic
extraction stays `not_extracted` with an empty findings array until a separately
validated extractor exists: empty means "not extracted", never "no findings".

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

`user` and `pm` may start, pause, resume, or cancel runs. `manager`, `agent`,
and `worker` are read-only. The only accepted admin identity is
`admin/metabot-local-lifecycle/local:daemon-lifecycle`; it may use the bounded
get/list operations needed by daemon health but cannot start, pause, resume,
or cancel. A signed admin capability with any other bot or chat is rejected
during authentication. A trusted principal's bot and chat are saved as the
run's `originator` when `arc_run_start` creates it; those values never come
from tool arguments. Project ID/root restrictions remain the separate trusted
server policy described above.

Capabilities use the frozen v2.1 Ed25519 form
`base64url(JSON claims).base64url(signature)` with exact claims
`{v:1,purpose:'arc',role,botName,chatId,exp}` and an optional `aud:'arc'`
audience claim. The audience is checked before any role or scope evaluation, so
a capability minted for another product server is refused on identity alone even
when the same issuer signed it. The claim stays optional so capabilities minted
before audiences existed keep working. The daemon holds the current
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
`~/.metabot/arc-projects` directory. Lifecycle health uses an authenticated
read-only MCP call. Engine session materialization remains a separate,
default-off integration.

## Direct client registration

MetaBot, Codex, and Claude each register `metabot-arc` directly. There is no
intermediate product gateway and no shared research audience: every client gets
the same entry name, the same loopback daemon endpoint, and its own per-turn
`aud=arc` capability file, so all three observe identical run state.

Entries materialize independently. A missing proxy, a non-loopback endpoint, or
a failed credential lease removes only that entry, so an unavailable ARC can
never disable Worker Runner and an unavailable Worker Runner can never disable
ARC. A proxy path reaches an engine configuration only after it is proven to be
a real executable confined to the runtime root.

## Development

```bash
npm run build -w @xvirobotics/arc-mcp
npm test -w @xvirobotics/arc-mcp
npm run typecheck -w @xvirobotics/arc-mcp
npm run lint -w @xvirobotics/arc-mcp
```
