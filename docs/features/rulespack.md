# RulesPack for Codex and Claude

RulesPack is a downstream-only, deterministic instruction-selection layer for
Codex and Claude. It compiles approved structured Rules once per turn at the
central engine boundary, never calls an LLM, and injects only the
engine-rendered bytes through Codex stdin or Claude's system-prompt appendix.
Kimi remains unsupported.

The checked-in engine is vendored at
`packages/rulespack/` from standalone commit
`1d866a994fb1ef8985b9df2f4ef3cb41f0926d81`. MetaBot-specific behavior is in
`packages/rulespack-adapter/`; the HTTP operator binding is isolated in
`src/extensions/rulespack-routes.ts`. The exact update procedure is recorded in
`packages/rulespack/VENDORED_FROM.md`; runtime code has no dependency on the
external FIX-009 checkout.

## Configuration

For multi-bot installations, configure shared audited-engine defaults once at
the root of `bots.json`. Every current or future Codex or Claude bot inherits
them, including hot-added Web bots and detached Worker Runner jobs. Kimi
reports `unsupported` and never instantiates a RulesPack runtime.

```json
{
  "rulesPackDefaults": {
    "policy": "required",
    "config": {
      "mode": "shadow",
      "hostId": "imac",
      "dbPath": "/var/lib/metabot/rulespack/{surface}-{bot}.sqlite",
      "budget": { "maxTokens": 2000, "maxCharacters": 8000 },
      "projectBindings": [
        { "projectId": "metabot", "root": "/srv/metabot" },
        { "projectId": "metabot", "root": "/srv/metabot-worktrees" }
      ],
      "projectChatBindings": [
        {
          "projectId": "metabot",
          "chats": [
            { "bot": "admin", "chatId": "oc_metabot_primary" },
            { "bot": "pm", "chatId": "oc_metabot_delivery" },
            { "bot": "pm-savio", "chatId": "oc_metabot_savio" }
          ]
        }
      ],
      "metaMemory": {
        "id": "imac-metabot-development",
        "hostRoot": "/imac",
        "paths": ["/imac/rules/codex/metabot-development"],
        "required": true,
        "freshForMs": 300000
      },
      "dispatch": {
        "issuer": "metabot-core-admin",
        "audience": "metabot-host:imac",
        "allowedIssuers": ["metabot-core-admin", "savio-bridge"],
        "maxEnvelopeTtlMs": 900000
      }
    }
  },
  "feishuBots": [
    { "name": "admin", "engine": "codex", "defaultWorkingDirectory": "/srv/metabot" },
    { "name": "secretary", "engine": "codex", "defaultWorkingDirectory": "/srv/workspaces" }
  ]
}
```

The default `dbPath` must contain both `{surface}` and `{bot}`. They produce
independent Bridge and Worker databases for every bot, preventing source or
operator state from leaking across runtimes. Bot names are globally unique
across channels after Unicode normalization and case folding, so filesystem
case behavior cannot alias two logical bots. A per-bot RulesPack object remains
supported as an override. With optional defaults, `"rulesPack": false` requires
a non-empty `rulesPackOptOutReason`; required defaults reject opt-out and reject
replacement of required sources or a per-bot downgrade to `mode: "off"`.
Emergency operator rollback remains available as an authenticated, durable,
auditable mode override. Every set/clear appends a metadata-only row to
`rulespack_adapter_mode_audit` in that surface's RulesPack database. `/api/bots` and
`GET /api/bots/:bot/rulespack/status` expose inherited, overridden, opted-out,
unconfigured, or unsupported state without revealing source contents or paths.
Dispatch identities are Bridge transport identities, not bot identities. Run
`metabot agents whoami` with the same `METABOT_CORE_TOKEN` (or token file) used
by the Bridge and copy its `botName` exactly into `dispatch.issuer`; receivers
list the sending Bridges' corresponding `botName` values in `allowedIssuers`.
All bots in one Bridge share that single issuer. `{bot}` and `{surface}` remain
valid only for isolated `dbPath` values (and for non-identity audience text);
startup rejects either placeholder in `issuer` or `allowedIssuers`. This is an
intentional migration error for the earlier `{bot}` example, not a silent
fallback. The sender also verifies Core-backed dispatches against `/api/whoami`
before direct or inbox delivery, and rejects/logs any mismatch.
For a static scoped peer, configure that peer's `auth.sourceBot` separately.
It names the local Bot whose operator compiles the envelope and whose task
identity the peer capability signs; it does not replace `dispatch.issuer`.
An authenticated scoped local principal selects that exact bot's operator even
though its bot name differs from the shared issuer. A generic Core bearer
selects a Bridge-wide operator only among bots configured with its authenticated
issuer: the issuer-named bot wins, then `admin`, then normalized bot name and
platform order. This deterministic fallback is derived only from the trusted
local registry; request content cannot choose the source operator.

Agent Bus target identity is independent of the registry bot name and URL. On
the first authenticated bulk registration, a Bridge proposes the exact live
`hostId` and `audience` reported by its RulesPack operator. Core binds that
non-secret pair to the existing credential using trust on first use; it neither
rotates nor reissues the token. Core stamps a separate `rulesPackIdentity`
attestation onto every agent row owned by that credential and returns the same
binding from `/api/whoami`. Later registration may repeat only the exact pair.
A different host or audience fails closed, as does active `shadow`/`enforce`
registration without an identity. Senders use only this attestation for the
remote subject and audience—never `botName`, URL host, peer display name, task
body, or prompt content. Legacy unconfigured and `off` bots may remain unbound,
but are not dispatchable RulesPack targets.

The same authenticated Bridge registration publishes the target bot's exact
`projectChatBindings` as deterministic SHA-256 subject keys plus project IDs.
Raw chat IDs are not exposed through peer discovery. A sender hashes its exact
`(bot, chatId)`, uses a matching target attestation before the target's
`defaultProjectId`, and rejects malformed, duplicate, or internally conflicting
metadata before compile. Core stores this additive array inside the existing
`rulespack_status` JSON; direct peers receive it over their existing
administrator-authenticated channel. The receiver still derives the project
from its own trusted cwd/chat configuration and verifies the complete subject
fingerprint, so a stale or false attestation fails closed before Codex.

An explicit `peers[].secret` authenticates to the remote Bridge as its local
API administrator. RulesPack therefore treats possession of that secret as
administrator-equivalent authority to assert the configured issuer and logs
that auth mode. Use this path only between mutually trusted administrators;
Agent Bus/Core bearer paths never receive this equivalence.

Worker startup resolves every configured bot using its declared `engine`.
Codex and Claude entries inherit shared defaults; Kimi remains `unsupported`.
Every bot-scoped RulesPack worker database must be durable and distinct from every
materialized Bridge or Worker database for every bot by canonical case-folded
path and, when present, device/inode. This also applies
to legacy per-bot objects: use `{surface}` or otherwise provide genuinely
separate Bridge/Worker paths. Exact paths, symlink/case aliases, hard links,
and cross-bot/cross-surface aliases that involve any worker SQLite file fail
Worker startup/control closed.

`hostId` must equal the first segment of `metaMemory.hostRoot`. Consequently a
Savio configuration with `hostId: "savio"` cannot load `/imac/...` paths.
Credentials are not configuration fields: the MetaMemory reader uses the
existing `METABOT_CORE_TOKEN` or user-owned token file and never records it.

### Project and chat membership

`projectBindings` declares trusted project roots. `projectChatBindings`
declares exact `(bot, chatId)` members of those projects. One project entry may
list any number of chats, including chats served by different bots. A Rule
with `scope: "project"` and `binding.projectId: "metabot"` therefore applies to
every listed MetaBot chat without copying the Rule or adding chat-specific
targets.

Both identities come from authenticated runtime/configuration data, never from
the prompt or Rule text. An exact chat binding may establish the project when
the current cwd is outside every configured root. If the cwd resolves to a
different configured project, the turn fails closed instead of choosing one.
The same `chatId` under another bot is a different chat, and one exact
`(bot, chatId)` tuple cannot belong to two projects.
For peer and Agent Bus dispatch, the target Bridge publishes only a hash of
that tuple; this lets the sender select the same project without disclosing the
raw chat ID in registry listings.

Project binding and target predicates are separate filters. For this target:

```json
{
  "binding": { "projectId": "metabot" },
  "targets": {
    "include": {
      "bots": ["pm", "pm-savio"],
      "roles": ["pm"]
    }
  }
}
```

- `bot` passes when it is `pm` **or** `pm-savio` because those values are in
  one `bots` list.
- `roles` passes when the authenticated role set contains `pm`.
- The Rule is selected only when the project binding, bot test, and role test
  all pass.

| Project | Bot | Roles contain `pm` | Selected |
| --- | --- | --- | --- |
| `metabot` | `pm` | yes | yes |
| `metabot` | `pm-savio` | yes | yes |
| `metabot` | `pm` | no | no |
| `metabot` | `admin` | yes | no |
| another project | `pm` | yes | no |

The same rule applies to `exclude`: values within one dimension are
alternatives, while all dimensions declared in that one exclusion predicate
must match before the Rule is excluded.

### User-wide defaults

Rules that express a personal default across every project and chat use
`scope: "global"`, no binding, and no target predicate. Keep them in a
separate required structured source such as
`config/rulespack/user-defaults.rules.json`; do not place them in a
project-bound native source, because project binding would narrow their
scope.

The shared `rulesPackDefaults` resolver applies this source to every current
and future Codex or Claude bot. A host may obtain the same structured Rules from its
local Meta Memory source or store them as `configRules`; the Rule IDs,
versions, lifecycle, and text must remain identical. Kimi remains explicitly
unsupported rather than pretending to receive these Rules.

Every Rule uses schema v1 from the engine API. `platform` and `runtime`
authority are accepted only from a source explicitly marked
`trustedAuthority`; curated Rules also require `metadata.approved: true`, and
temporary Rules require an expiry. Project-native Rules are rebound to the
configured project root/ID after path containment checks, so they cannot leak
to another working directory.

JSON native files use:

```json
{ "schemaVersion": 1, "revision": "1", "rules": [] }
```

An explicitly listed `AGENTS.md` may contain exactly one fenced
`rulespack-json` block containing the same object. Surrounding Markdown is
never interpreted. Set `nativeLoaded: true` when Codex already loads that
file; RulesPack then tracks its generation without injecting duplicate text.
File watchers debounce refreshes, and optional periodic refresh is configured
with `refreshIntervalMs`. No Markdown, filesystem, or MetaMemory scan occurs
on the per-turn hot path.

Detached Worker Runner automatically resolves the same `rulesPackDefaults`
from its existing `BOTS_CONFIG`; it materializes the `worker` surface database
and never passes the bot configuration or Core credential to child processes.
`METABOT_RULESPACK_CONFIG` remains a backward-compatible standalone override,
but is mutually exclusive with `BOTS_CONFIG` so required shared policy cannot
be shadowed by a legacy daemon-only file.
ARC jobs executed through Worker Runner use the same bounded worker boundary.
When a Codex or Claude turn consumed an authenticated remote dispatch, Bridge signs a
one-level `RulesPackChildGrantV1` bound to that turn's Worker capability and
leases it as a private per-turn companion file. It is not a tool argument or a
model-visible environment value. Worker verifies its signature, capability
digest, parent envelope, expiry, and exact scope, persists it privately with
the job for recovery, and rebinds the selected Rules to the server-assigned
Worker/task ID in the independent worker-surface database. Codex injects the
policy through stdin; Claude uses its system-prompt channel. Kimi jobs carrying
a grant are rejected.

Native `metabot-arcd`/official AutoResearchClaw execution does not yet have a
verified Codex stdin boundary for received exact dispatch Rules. The native ARC
MCP tool is therefore omitted from a turn carrying a received dispatch. Only
ARC work explicitly executed through Worker Runner's `executionKind: arc` uses
this descendant contract.
Savio must use Savio-local files/Memory plus authenticated received Rules; it
never opens iMac MetaMemory.

The Bridge operator coordinates bot-scoped mode changes with the already-running
Worker daemon over a dedicated loopback-only endpoint beneath the configured MCP
path. Bridge mints the existing short-lived fixed lifecycle capability for this
host-to-host request; neither the capability, `BOTS_CONFIG`, source configuration,
nor Core credentials enter a Codex child environment. The daemon accepts no
PM/user/engine capability for this endpoint and delegates persistence to its
current RulesPack provider/runtime. It never edits `workers.sqlite` directly.
Bot-scoped hot control requires the shared `BOTS_CONFIG` form. The legacy
`METABOT_RULESPACK_CONFIG` is process-wide, so the daemon reports it as
`standalone-shared` and rejects a bot-scoped PATCH rather than pretending the
requested bot alone changed.

## Runtime and session flow

1. Startup/config/file/Memory events refresh immutable structured source
   generations into the RulesPack-owned database.
2. `MessageBridge.runOneTurn` constructs the Codex or Claude `ExecutionSubject` from the
   configured host, bot registry, authenticated principal/capability,
   authenticated chat/user, configured chat/cwd-to-project bindings, internal child
   task/agent/worker facts, and materialized tools/output declarations. Prompt
   or Rule content is never an identity/authority source.
3. The adapter calls the engine once. `off` emits no injection and bypass
   telemetry; `shadow` compiles/records but injects nothing; `enforce` passes
   only `injectionText` to the selected audited executor.
4. Codex prepends those bytes to its single truthful stdin user input. Claude
   places the same bytes first in the default system-prompt appendix for both
   legacy and persistent executors. Pack IDs, subjects, decisions, and
   telemetry do not enter model context.
5. The session manager compares the effective pack digest at the boundary.
   An unchanged digest resumes the engine session. A changed digest—or rollback
   from enforce to off—clears the provider session ID before spawning the next
   turn. In-flight turns are never mutated.
6. Agent Team and scheduled calls add authenticated agent/task facts before the
   same hook. Detached Worker/ARC-via-Worker creates a worker/ARC subject from
   its pinned capability principal and durable worker ID, then injects at its
   direct Codex stdin or Claude system-prompt boundary. A received parent dispatch reaches it only via
   the signed child grant; restart relaunches re-verify that private grant and
   repeat the boundary check from durable facts.

Worker mode changes affect the current daemon at the next audited-engine policy
preparation boundary. They cannot change a launch preparation that already
captured its mode or remove instructions already delivered to a process, so
operator responses state `appliesTo: subsequent-rulespack-policy-preparations` and
`inFlight: unchanged`; Kimi remains unsupported and unchanged.

For authenticated resident-Bridge peer/Agent Bus work, the dispatcher compiles an exact
remote-host subject and sends `RulesPackDispatchEnvelopeV1`. The receiver
requires its already-authenticated transport marker, exact issuer allowlist,
audience, target fingerprint, bounded lifetime, verified pack digest, and a
one-time replay ID. The receiver first claims a bounded replay lease and
compiles the verified pack's selected Rule objects as an in-memory provisional
source rebound to the complete target subject fingerprint. It writes neither
the source nor a cache/LKG containing those Rules before target acceptance. On
exact target input acceptance, one SQLite transaction persists the
envelope-expiring, namespaced temporary source and moves the replay to
`accepted`; explicit spawn/stdin/transport rejection moves it to `rejected` so
the same authenticated envelope may be retried before expiry. Concurrent
prepared claims and accepted replays remain rejected. A stale `prepared` lease
can be reclaimed only by the byte-equivalent envelope after the bounded lease
and before envelope expiry. A different chat/project/agent/worker/task/host
never inherits those Rules from the shared database; it needs its own
authenticated exact envelope.
Registry-discovered targets must carry Core's credential-bound
`rulesPackIdentity`. A direct static peer may advertise the same live operator
identity over its existing administrator-authenticated peer-secret channel.
An envelope whose audience or target host differs from that authenticated
identity is rejected before forwarding.
Peer discovery publishes both an explicit `defaultProjectId` for the target
bot's configured working directory (`null` means it is deliberately unbound)
and hashed exact-chat project attestations. An exact chat attestation takes
precedence; a non-null default and exact chat project must agree. Automatic
dispatch fails closed when authenticated metadata is malformed or conflicts
with a scoped Agent/Task project; it never guesses a project from the request
body and the receiver still verifies the complete target fingerprint.
This lets local mandatory policy overlay
through normal engine precedence without editing received rendered text. The
same Bridge database lets later turns with the identical subject compile their
exact subset. A detached Worker or ARC-via-Worker child instead consumes its
signed grant, rebinds the selected Rules to its complete child subject, and
persists them only in its separate worker-surface database. The resulting local pack
digest controls session refresh. A rejected target/replay never reaches Codex.
Core-bearer transports bind the envelope issuer to authenticated `/api/whoami`
`botName`; local peer-secret transport is administrator-equivalent and binds
the explicitly forwarded issuer. A generic bearer does not authenticate a
caller-selected chat/project/role/task/worker and skips RulesPack for that API
turn. Normal verified resident-Bridge peer forwarding attaches an exact
envelope automatically. A signed engine session may also use
`metabot agents talk` for the same Bot in another chat on its resident Bridge:
the short-lived source capability authorizes only the talk/status routes, the
receiver constructs an exact target Bot/Chat principal, and the command returns
an asynchronous task/card receipt. CLI-only and remote inbox senders still
cannot manufacture an exact dispatch; Core therefore rejects their
envelope-free relay to a target that advertises required, shadow, or enforce
RulesPack state. Unconfigured, opted-out, unsupported, and optional-off CLI
agents retain the plain inbox contract.

Peer delivery is successful only when the receiver reports a consumed
acknowledgement bound to the exact envelope ID, replay ID, and pack digest.
Unknown, opted-out, unconfigured, or live-`off` peers are rejected before
forwarding; an authenticated envelope received while local mode is off is also
rejected rather than executed without policy.
Envelope-bearing Core inbox relay is explicitly asynchronous: enqueue returns
a digest-bound `queued` acknowledgement, while the receiver records the later
exact `consumed` receipt before completing its engine turn. It is never reported
as already consumed at enqueue time. Core checks that a protected relay's
envelope target equals the queued bot/chat and that its issuer equals the
authenticated sending credential before accepting it; the receiver still owns
the full digest, audience, expiry, replay, and target verification.

## Storage, telemetry, and failure semantics

The default database is
`${SESSION_STORE_DIR:-~/.metabot}/rulespack/rules-state.sqlite`. It is rejected
if it aliases a known/configured MetaMemory, session, Agent Team, Worker, or ARC
database by basename, canonical path, symlink/inode, or contains a foreign
application schema. Engine schema v3 owns Rule history/current pointers,
revocations, source generations, persistent cache/source index, authoritative
compile provenance, cache-key-bound LKG, cache metadata, redacted audit,
receipts, and feedback. Pre-v3 cache/LKG rows have no authoritative provenance
and are not recovery candidates. Adapter tables add only settings and
prepared/accepted/rejected replay leases. Worker storage receives additive
`principal_role`, `execution_kind`, `rulespack_child_grant_json`, and
`rulespack_child_grant_digest` columns so restart recovery reconstructs and
re-authenticates the same child subject. Grant fields are private and never
enter Worker records, status, callbacks, or logs. Legacy rows without identity
evidence remain `unknown`/degraded and
do not default to ordinary Worker targeting.

Compile telemetry records latency, memory/persistent hit or miss, candidate and
selected/excluded counts, characters/token estimate, digest, generation and
freshness, degraded/LKG state, and bounded reasons. Adapter status also reports
target-mismatch and replay rejections. Audits and logs exclude Rule bodies and
redact secret-shaped fields. Receipts say `compiled`/`shadowed` before spawn,
`injected` only after the selected audited engine accepts that prepared input, `consumed` only after
the corresponding target acceptance, and `rejected` on failure.

Optional-source failures use a bounded stored generation and report degraded
state. Required-source, path escape, unsafe Rule text, mandatory budget,
dependency, target, expiry, tamper, and replay failures fail closed. Only the
current snapshot of an expired optional temporary delivery is replaced by an
empty fresh tombstone, so it cannot degrade unrelated policy; immutable Rule
versions, replay rows, audit events and receipts remain available.
Only an explicit transient `COMPILE_UNAVAILABLE` failure may use engine-verified
bounded LKG, and only after the complete current source snapshot passes schema,
digest, authority, lifecycle, target, text, and store integrity validation and
its exact compiler/mode/budget/subject/source cache key resolves through a
persisted engine compile record to digest-verified pack bytes. The store creates
that record only after checking the complete current Rule input and independently
re-running the deterministic compiler; raw caller-supplied cache/LKG promotion
is unavailable. Packs expire at or before every Rule lifecycle transition,
including transitions of Rules that were not selected in the old pack. A future
Rule is safe to omit before its `validFrom` only when the pack expires no later
than that boundary; at the boundary, fresh compile is required.
Mode `off` resolves before source fail-closed checks and continues with a
degraded empty pack even when required source state is stale, unavailable, or
corrupt.
Every compile/cache decision re-evaluates `freshUntil`; pre-expiry timers
refresh configured sources, including Meta Memory, outside the turn hot path.
RulesPack Meta Memory Core URLs are loopback-only without an explicit
authenticated local-host identity mechanism.

## Operator surface

All endpoints remain behind the existing MetaBot API authentication gate:

```text
GET   /api/bots/:bot/rulespack/status
PATCH /api/bots/:bot/rulespack/mode               {"mode":"off|shadow|enforce|null"}
POST  /api/bots/:bot/rulespack/refresh
POST  /api/bots/:bot/rulespack/explain
GET   /api/bots/:bot/rulespack/cache/status
POST  /api/bots/:bot/rulespack/cache/clear
GET   /api/bots/:bot/rulespack/receipts?digest=&limit=
GET   /api/bots/:bot/rulespack/feedback?digest=&limit=
POST  /api/bots/:bot/rulespack/feedback
POST  /api/bots/:bot/rulespack/temporary
POST  /api/bots/:bot/rulespack/dispatch/compile
```

`GET .../status` includes `workerRulesPack`. A confirmed value reports the
current worker-surface mode, configured mode, durable override timestamp,
monotonic `operatorModeVersion`, last `operatorModeOperationId`, and the
in-flight boundary. An unavailable daemon is reported as
`coordination: unavailable` rather than being inferred from Bridge state.

PATCH is a fail-closed two-surface operation, serialized for the complete
read/mutate/compensate flow of each bot. It preflights Worker status, then sends
an unguessable operation ID plus the exact expected version. Worker changes the
override, version, operation ID, and audit row in one SQLite transaction; a
stale expected version is rejected. Only a matching `version + 1`, operation
ID, mode, and durable override is a trusted acknowledgement. Bridge then uses
the same CAS contract locally before publishing peer status, and re-reads the
Worker version/operation once more before returning HTTP 200. A different
operation observed at that final boundary prevents a confirmed response and is
never overwritten.
Peer publication is awaited, carries the durable Bridge
`operatorModeVersion + operatorModeOperationId`, and is followed by one more
Worker re-read before HTTP 200. Core rejects an older generation, a conflicting
operation at the same generation, and an unversioned update after a versioned
status. Publication failure restores both surfaces and publishes the higher
compensation generation before the route may report `coordination: restored`;
an unconfirmed restoration remains indeterminate.

A preflight failure is `WORKER_PREFLIGHT_FAILED` with both mutation-attempt
flags false. A mutation timeout, disconnect, or invalid acknowledgement is
never treated as proof that Worker stayed unchanged. The coordinator re-reads,
uses a new operation ID to fence and restore the prior value even when the
first request appeared not to commit, then re-reads again. A confirmed restore
returns `WORKER_MUTATION_FAILED` with `coordination: restored`. If the observed
version belongs to another operation, it is never overwritten. Any unconfirmed
read/fence/restore returns `RULESPACK_COORDINATION_INDETERMINATE` without
claiming two-surface consistency. A later Bridge failure similarly returns
`BRIDGE_MODE_UPDATE_FAILED` only after both surfaces are confirmed restored;
otherwise it returns the indeterminate code. Repeating a requested mode is
effective-state idempotent but deliberately advances the audit/CAS version.

Temporary and explain/dispatch requests accept structured subject fields; they
are operator declarations under authenticated API authority and are never read
from the task prompt. The vendored `rulespack` CLI additionally supports
validate/import/revoke/compile/explain/status/cache/receipt/feedback/audit for
offline database operation.

The repository also runs three mechanical policy gates: downstream boundary
validation, added-line high-confidence secret scanning, and a feature-branch
history check that requires exactly one final commit, including tests,
documentation, and review repairs. Controlled restart/deployment capability
checks remain runtime enforcement; RulesPack `enforce` guarantees delivery,
not model compliance and not authorization.

## Migration and rollback

No existing live database is replaced. `projectChatBindings` is configuration
only and adds no database table or migration. Its hashed peer attestations are
stored inside the existing nullable `agents.rulespack_status` JSON and require
no new column. On first start, the adapter creates the
independent RulesPack database and additive schema in one file, including the
metadata-only operator mode audit table and durable CAS state. Worker Runner
adds nullable identity columns plus two private nullable child-grant columns to
its own worker table, and Core adds
nullable `agents.rulespack_status`, `rulespack_host_id`, and
`rulespack_audience` metadata plus credential-bound host/audience columns in
its existing `central.db`; old rows remain `NULL` until authenticated Bridge
registration. Existing tokens remain valid. Their first authenticated Bridge
bulk registration binds the live operator identity; thereafter a mismatch is
rejected and requires operator investigation rather than automatic credential
or identity replacement. Before an authorized deployment, use SQLite online
backup (or stop the owning process) for Core `central.db`, Worker
`workers.sqlite`, and every existing RulesPack database—never copy only a live
main file while ignoring WAL/SHM. Record compiler/schema versions, start in
`off`, refresh/status, then move to `shadow` before any separately approved
`enforce` cutover. Verify the Core agent row count/ownership/visibility is
unchanged and the nullable status/identity columns are readable after migration.

Rollback is non-destructive:

1. PATCH mode to `off`. Treat HTTP 200 plus
   `workerRulesPack.coordination: confirmed`, worker `mode: off`, and a durable
   `operatorModeOverride` timestamp plus matching CAS version/operation ID as
   the hot-rollback acknowledgement. The
   Bridge and worker-surface overrides survive their independent restarts and
   take precedence until PATCH with `mode: null` clears both.
2. Let active Bridge turns, already-started Worker launch preparations, and
   already-launched Worker processes finish;
   sessions with prior Rules bytes recycle only at their next boundary, and
   future Worker Codex launches observe `off`.
3. Keep Rule history, receipts, feedback, and databases in place.
4. Revert the adapter/code revision if required.
5. Clear only recomputable pack cache/LKG when compiler compatibility requires
   it. There is no down migration: old Core/Worker code ignores the additive
   nullable metadata. Do not drop the column or replace a live database; a full
   database restore requires separately authorized downtime and a consistent
   backup. There is no MetaMemory, Agent Team, ARC, session, or live database
   replacement in the normal rollback.

Deployment order matters for this protocol: deploy the Worker daemon endpoint
before relying on the new Bridge PATCH behavior. A new Bridge talking to an old
or unavailable Worker fails the PATCH with Bridge unchanged. For a code rollback
that removes the endpoint, first obtain the confirmed two-surface `off`
acknowledgement; otherwise set both surface configurations to `off` and use the
separately authorized controlled restart path instead of claiming a hot rollback.
