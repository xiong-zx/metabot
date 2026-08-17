# Agent Team Governance Extension

`src/agent-teams/governance-extension.ts` is the downstream W01 policy layer
for the upstream Agent Team runtime. It preserves `AgentTeamStore` as the
execution-state source of truth and integrates with the existing supervisor
through narrow lifecycle, quota, prompt, and recycling hooks.

The extension owns a separate SQLite database containing immutable Template
and RuleSet versions, scope-bound instance metadata, temporary-Agent leases,
quota configuration, and an audit log. The upstream store remains the source
of truth for Teams, Agents, Tasks, Messages, Runs, and supervisor execution.
`createAgentTeamGovernanceHost()` is the only adapter between the two stores.

## Policy

- New instances default to `chat` scope and require a chat id. `project` scope
  requires a project id. `global` scope requires the explicit
  `allowGlobal: true` opt-in, and context lookup ignores global instances unless
  `includeGlobal: true` is requested.
- An instance pins the exact Template digest/version and every referenced
  RuleSet digest/version. Publishing a newer version does not mutate existing
  instances.
- Only `admin`, `user`, and `pm` actors may create/start/stop/delete Teams or
  Agents, stop Runs, dispatch a Worker, restart/update services, or promote
  Templates/RuleSets. A `manager` or `agent` may only coordinate its existing,
  signed Team scope through Tasks and Messages. Workers receive no governance
  capability. Missing or untrusted principals fail closed.
- Quotas cover Teams per scope, active and temporary Agents, queued Tasks,
  active Runs, and parallel Runs per Agent. Temporary Agents require a positive
  TTL. An optional `temporaryAgentIdleMs` policy also reaps an unused temporary
  Agent. Reaping stops the upstream Agent, releases its governed slot, and
  returns the running Run/task identifiers that the supervisor must stop and
  requeue.
- Promotions, instance/Agent creation, TTL recycling, authority decisions, and
  quota denials are auditable.
- Each instance may pin its owning PM bot. `prepareRun()` returns that bot and
  a stable `teaminst:<instance>:<agent>` chat id without changing
  upstream session records. Supervisor activity cards use the same pinned PM
  bot before falling back to the global execution bot.
- Rule targets are exact and fail closed. An omitted target applies to every
  Agent in the instance; `agent:<name>` and `role:<role>` match only the
  current governed execution subject. Legacy unprefixed targets normalize to
  exact Agent names. Wildcards and unknown target syntax are rejected when a
  RuleSet is published, and invalid pinned legacy data blocks execution.
- Governed upstream Team names use only `[a-z0-9._-]` and reserve the `atg-`
  prefix. Startup reconciliation recreates missing upstream rows, restores the
  governed active/stopped state, repairs missing pinned Template members, and
  stops `atg-` upstream orphans. Template and RuleSet JSON is re-hashed whenever
  it is read, so corrupt or changed pinned content fails closed.

## Runtime integration

The HTTP composition root constructs and closes the extension beside the
upstream store. `/api/agent-team-governance/{templates,rules,instances,audit}`
is separate from the legacy `/api/agent-teams` surface. Legacy and
configuration-managed Teams remain compatible, while a direct mutation whose
Team name belongs to a governed instance is routed through governance or
rejected.

The bridge creates a random in-process signing key at startup. Every engine
session receives a short-lived signed execution capability containing its
runtime-derived role, bot, chat, Team, Agent, and expiry; the signing key is
never passed to an engine. Bridge-local administrator credentials are removed
from the Claude, Codex, and Kimi subprocess environments. `metabot teams`
forwards the scoped capability in request headers, and Agent Team routes accept
that signature without also requiring the local administrator secret. A
request carrying engine bot/chat markers fails closed when its capability is
absent, invalid, expired, or for another session, even if it somehow presents
the local secret. Only an external CLI request authenticated by the bridge API
secret and carrying no engine markers is treated as local admin. Request-body
`role` or `actorRole` fields never select the caller's authority.

The same capability may authenticate four non-Team, read-only Bridge requests:
`GET /api/bots`, `GET /api/peers`, `GET /api/stats`, and `GET /api/metrics`.
An `admin`, `user`, or `pm` principal may also list and manage schedules only
when both `botName` and `chatId` match its signed execution scope. Managers,
agents, and cross-scope IDs fail closed. The capability does not authenticate
bot details or profiles, talk, Workers, service operations, peer/bot
mutations, or any other Bridge route. A request carrying any engine
capability/bot/chat header cannot fall back to the local administrator secret
or cross-bridge token validation.
Human and local management mutations require `API_SECRET`; loopback access is
not an unauthenticated management path.

Capabilities live for one hour. The composition root caches one credential per
bot/chat only until five minutes before expiry, then retires an idle persistent
executor immediately or waits for its active turn to finish. The next turn
receives a new signature; the executor registry also respawns a healthy
persistent executor whenever its execution environment changes. An overlong
active turn can only hold an expired, unusable capability until it drains; the
credential is never refreshed in place or left valid indefinitely.

The supervisor checks governed Run quotas immediately before `createRun()`,
uses the pinned PM bot and stable instance chat, injects pinned RuleSets into
the member prompt, touches lease activity, and executes reap actions by
stopping owned Runs/chats and requeueing interrupted Tasks.

Pending Tasks may still use the configured per-Agent parallel Run capacity,
and task-associated wake-up Messages stay attached to those task lanes. An
unrelated unread coordination Message does not open a separate message-only
Run while that Agent already has active task work; it remains unread until the
active task Runs drain.

## Concurrency invariant

Governance and upstream state are two local SQLite databases owned by one
bridge process. Quota checks and their immediately following upstream mutation
are synchronous and must remain in that single process; running two bridge
processes against the same pair of database files is unsupported. Startup
reconciliation repairs either half of a process crash. A future multi-process
deployment must replace this invariant with a shared transactional reservation
service before it is supported.

These hooks stay thin. Do not copy governance columns or policy methods into
the upstream store or replace the supervisor.
