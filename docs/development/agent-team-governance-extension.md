# Agent Team Governance Extension

`src/agent-teams/governance-extension.ts` is the downstream W01 policy layer
for the upstream Agent Team runtime. It deliberately does not replace or alter
`AgentTeamStore` or `AgentTeamSupervisor`.

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
  Templates/RuleSets. A `manager` may only authorize
  `coordinate_existing_agents`; Agents and Workers receive no governance
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
  a stable `teaminst:<instance>:<agent>[:<run>]` chat id without changing
  upstream session records.

## Integration hooks

The extension is intentionally not registered in the bridge composition root
by the isolated W01 module. Integration should construct it beside
`AgentTeamStore` and close it with the HTTP server lifecycle. API/CLI creation
routes must call `authorize()` or the governed creation methods with a
principal built by the authenticated transport; never accept `role` directly
from a request body. Task creation
must call `assertCanQueueTask()`, and the supervisor must call
`assertCanStartRun()` immediately before it creates a Run. The supervisor must
also use `prepareRun()`, call `touchAgent()` on run activity, and apply the
stop/requeue actions returned by `reapExpired()` during maintenance. Prompt
assembly may use `buildRulesContext()` to read only the versions pinned by the
instance.

These hooks should stay thin. Do not copy governance columns or policy methods
into the upstream store or supervisor.
