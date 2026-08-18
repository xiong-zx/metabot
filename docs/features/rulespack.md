# RulesPack for Codex

RulesPack is a downstream-only, deterministic instruction-selection layer for
Codex. It compiles approved structured Rules once per turn at the central
Codex boundary, never calls an LLM, and injects only the engine-rendered bytes
in Codex's user-channel prelude. Claude and Kimi are unchanged.

The checked-in engine is vendored at
`packages/rulespack/` from standalone commit
`1d866a994fb1ef8985b9df2f4ef3cb41f0926d81`. MetaBot-specific behavior is in
`packages/rulespack-adapter/`; the HTTP operator binding is isolated in
`src/extensions/rulespack-routes.ts`. The exact update procedure is recorded in
`packages/rulespack/VENDORED_FROM.md`; runtime code has no dependency on the
external FIX-009 checkout.

## Configuration

RulesPack is configured per Codex bot in `bots.json`. Omitting `rulesPack`, or
omitting its `mode`, leaves it safely off. A minimal configuration is:

```json
{
  "name": "admin",
  "engine": "codex",
  "defaultWorkingDirectory": "/srv/workspaces",
  "rulesPack": {
    "mode": "shadow",
    "hostId": "imac",
    "dbPath": "/var/lib/metabot/rulespack/rules-state.sqlite",
    "budget": { "maxTokens": 2000, "maxCharacters": 8000 },
    "configRules": {
      "id": "runtime-config",
      "revision": "2026-08-18",
      "trustedAuthority": true,
      "rules": []
    },
    "ruleSets": [],
    "curatedRules": [],
    "projectBindings": [
      {
        "projectId": "fix-009",
        "root": "/srv/workspaces/fix-009",
        "nativeFiles": [
          { "id": "fix-009-rules", "path": ".metabot/rulespack.json", "format": "json" },
          { "id": "fix-009-agents", "path": "AGENTS.md", "format": "agents-json-block", "nativeLoaded": true }
        ]
      }
    ],
    "metaMemory": {
      "id": "imac-memory",
      "hostRoot": "/imac",
      "paths": ["/imac/rules/codex"],
      "freshForMs": 300000
    },
    "dispatch": {
      "issuer": "admin",
      "audience": "metabot-host:imac",
      "allowedIssuers": ["pm-savio"],
      "maxEnvelopeTtlMs": 900000
    }
  }
}
```

`hostId` must equal the first segment of `metaMemory.hostRoot`. Consequently a
Savio configuration with `hostId: "savio"` cannot load `/imac/...` paths.
Credentials are not configuration fields: the MetaMemory reader uses the
existing `METABOT_CORE_TOKEN` or user-owned token file and never records it.

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

Detached Worker/ARC daemons opt in with `METABOT_RULESPACK_CONFIG` pointing to
a bounded local JSON object containing the same `rulesPack` configuration.
The file is read by the daemon, not passed to child processes. Configure the
daemon and Bridge with the same host-local RulesPack database when dispatched
Rules must flow into detached children. Savio then uses only Savio-local
files/Memory plus authenticated received Rules; it never opens iMac MetaMemory.

## Runtime and session flow

1. Startup/config/file/Memory events refresh immutable structured source
   generations into the RulesPack-owned database.
2. `MessageBridge.runOneTurn` constructs the Codex `ExecutionSubject` from the
   configured host, bot registry, authenticated principal/capability,
   authenticated chat/user, configured cwd-to-project binding, internal child
   task/agent/worker facts, and materialized tools/output declarations. Prompt
   or Rule content is never an identity/authority source.
3. The adapter calls the engine once. `off` emits no injection and bypass
   telemetry; `shadow` compiles/records but injects nothing; `enforce` passes
   only `injectionText` to the Codex executor.
4. The Codex executor prepends those bytes to its single truthful user-channel
   input, before the actual user prompt and normal MetaBot context. Pack IDs,
   subjects, decisions, and telemetry do not enter model context.
5. The session manager compares the effective pack digest at the boundary.
   An unchanged digest resumes the Codex session. A changed digest—or rollback
   from enforce to off—clears the provider session ID before spawning the next
   turn. In-flight turns are never mutated.
6. Agent Team and scheduled calls add authenticated agent/task facts before the
   same hook. Detached Worker/ARC creates a worker/ARC subject from its pinned
   capability principal and durable worker ID, then injects at its direct
   Codex stdin boundary. Restart relaunches repeat the boundary check from
   durable facts.

For authenticated peer/Agent Bus work, the dispatcher compiles an exact
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
This lets local mandatory policy overlay
through normal engine precedence without editing received rendered text. The
same database lets later turns and detached Worker/ARC children compile their
own exact subset without reading dispatcher sources. The resulting local pack
digest controls session refresh. A rejected target/replay never reaches Codex.
Core-bearer transports bind the envelope issuer to authenticated `/api/whoami`
`botName`; local peer-secret transport is administrator-equivalent and binds
the explicitly forwarded issuer. A generic bearer does not authenticate a
caller-selected chat/project/role/task/worker and skips RulesPack for that API
turn. Normal verified peer and Agent Bus forwarding attaches an exact envelope
automatically.

## Storage, telemetry, and failure semantics

The default database is
`${SESSION_STORE_DIR:-~/.metabot}/rulespack/rules-state.sqlite`. It is rejected
if it aliases a known/configured MetaMemory, session, Agent Team, Worker, or ARC
database by basename, canonical path, symlink/inode, or contains a foreign
application schema. Engine schema v1 owns Rule history/current pointers, revocations,
source generations, persistent cache/source index, cache metadata, LKG,
redacted audit, receipts, and feedback. Adapter tables add only settings and
prepared/accepted/rejected replay leases. Worker storage receives additive `principal_role` and
`execution_kind` columns so restart recovery reconstructs the same child
subject. Legacy rows without identity evidence remain `unknown`/degraded and
do not default to ordinary Worker targeting.

Compile telemetry records latency, memory/persistent hit or miss, candidate and
selected/excluded counts, characters/token estimate, digest, generation and
freshness, degraded/LKG state, and bounded reasons. Adapter status also reports
target-mismatch and replay rejections. Audits and logs exclude Rule bodies and
redact secret-shaped fields. Receipts say `compiled`/`shadowed` before spawn,
`injected` only after Codex accepts that prepared input, `consumed` only after
the corresponding target acceptance, and `rejected` on failure.

Optional-source failures use a bounded stored generation and report degraded
state. Required-source, path escape, unsafe Rule text, mandatory budget,
dependency, target, expiry, tamper, and replay failures fail closed. Only the
explicit transient `COMPILE_UNAVAILABLE` failure may use engine-verified
bounded LKG, and only after the complete current source snapshot passes schema,
digest, authority, lifecycle, target, text, and store integrity validation and
its recomputed compiler/mode/budget/subject/source identity exactly matches the
current compile request. Packs expire before any Rule lifecycle transition,
including transitions of Rules that were not selected in the old pack.
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

Temporary and explain/dispatch requests accept structured subject fields; they
are operator declarations under authenticated API authority and are never read
from the task prompt. The vendored `rulespack` CLI additionally supports
validate/import/revoke/compile/explain/status/cache/receipt/feedback/audit for
offline database operation.

## Migration and rollback

No existing live database is reused or replaced. On first start, the adapter
creates the independent RulesPack database and additive schema in one file;
Worker Runner adds two nullable-safe defaulted columns to its own worker table.
Before an authorized deployment, back up the RulesPack and Worker databases,
record compiler/schema versions, start in `off`, refresh/status, then move to
`shadow` before any separately approved `enforce` cutover.

Rollback is non-destructive:

1. PATCH mode to `off` (or set configuration to off). The operator override is
   durable across restart and takes precedence until PATCH with `mode: null`
   clears it.
2. Let active turns finish; sessions with prior Rules bytes recycle only at
   their next boundary.
3. Keep Rule history, receipts, feedback, and databases in place.
4. Revert the adapter/code revision if required.
5. Clear only recomputable pack cache/LKG when compiler compatibility requires
   it. There is no down migration and no MetaMemory, Agent Team, ARC, session,
   or live database replacement.
