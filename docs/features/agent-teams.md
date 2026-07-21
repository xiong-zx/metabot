# Agent Teams

MetaBot Agent Teams let a user-facing Bot / PM coordinate internal agents through the local bridge. The coordination model is engine-neutral: teams can declare Claude, Codex, or Kimi agents, and all coordination is stored in the bridge database instead of being hidden inside one model session. Execution still runs through the current bridge and session-engine path, so each configured engine must be supported by that bridge runtime.

## What It Does

Agent Teams is the runtime team experience for larger work:

- An **Agent Team Template** defines default agents, shared prompts, skills, workflow policy, quality gates, and execution defaults.
- An **Agent Team Instance** is the runtime state for one chat or project, with isolated agents, mailbox messages, shared tasks, runs, virtual chats, and activity cards.
- A **PM Bot** creates or reuses team instances, assigns work, and integrates the final user-facing result.
- An **Agent** runs in an independent chat session on the bridge that executes the team. Legacy teams use `team:<team>:<agent>`; scoped runtime instances use `teaminst:<instanceId>:<agent>`.
- Agents coordinate with `metabot teams`, so progress is visible to the PM, other agents, Feishu cards, and future supervisor automation.

This is the runtime counterpart to [MetaSkill](metaskill.md): MetaSkill generates portable team prompts and skills; Agent Teams runs a live team.

## Target Model: Template / Instance / Pinning

`agentTeams` in `bots.json` should be treated as bootstrapped **Agent Team Templates**, not global shared runtime teams. On startup or import, the bridge writes those templates into a versioned template store. At runtime, each chat or project creates its own **Agent Team Instance**.

Key rules:

- Templates are reusable; runtime instances must be isolated.
- The default scope is `chat`: one Feishu chat maps to one project instance.
- `project` scope requires an explicit `projectId` and can bind multiple chats to one project.
- `global` scope is only for rare shared operations or cross-project expert groups. It must be explicit and is not the default.
- Every instance pins an immutable `templateId@version` and content digest.
- Template updates do not automatically change running instances; upgrades require a diff/migration plan and PM or user approval.
- Instances can stay on an old version, refresh manually, or roll back to an old pin.

Example:

```text
Template: research-codex v3

Instance: research-codex@chat:oc_project_a
  pinned_template: research-codex v2
  PM: pm-codex
  virtual chats:
    teaminst:<instanceId>:manager
    teaminst:<instanceId>:planner
    teaminst:<instanceId>:coder

Instance: research-codex@chat:oc_project_b
  pinned_template: research-codex v3
  PM: pm-claude
  virtual chats:
    teaminst:<instanceId>:manager
    teaminst:<instanceId>:planner
    teaminst:<instanceId>:reviewer
```

The current implementation still keeps the public CLI/API selector compatible with legacy `teamName`, but scoped runtime instances now persist child rows with `instance_id` and run Agent sessions as `teaminst:<instanceId>:<agent>`. The remaining risk is the older `teamName` coordination surface and activity/recovery paths that still need to become fully `instanceId`-keyed.

## Authority Boundary: PM / Manager / Agent / Worker

The PM and team manager are not equivalent roles:

| Role | Can do | Should not do |
| --- | --- | --- |
| PM Bot | Create or bind team instances, create or stop agents within quota, approve template/rules upgrades, approve `worker_dispatch`, report to the user | Promote unapproved project experience into global templates or rules |
| Team manager Agent | Coordinate internal agents, maintain internal tasks, summarize status, detect blockers, request workers or approvals from the PM | Create new agents, run `worker_dispatch`, restart services, promote templates, edit privileged rules |
| Agent | Perform its planner/coder/experiment/reviewer role and return structured output | Create agents, edit templates, read unauthorized cross-project context |
| Worker | Execute one-off code, experiment, search, or evaluation work and return structured output | Hold long-term memory or coordinate the team |

A research team can run a `manager -> planner/coder/experiment/reviewer` loop. The manager frees the PM from internal coordination, but it must not inherit PM authority.

## Shared Rules

Bots, agents, and workers need shared rules, but rules should not live only in prompts or opaque database rows. The target design compiles a versioned RuleSet into a Rules Context Pack for each run.

Recommended hierarchy:

1. System/runtime safety rules: not user-overridable.
2. Org/global rules: shared by all Bots, Agents, and Workers, for example "after code changes, check whether docs and corresponding MetaMemory need updates, and report anything not done."
3. Bot-level rules: one Bot's entry role, permissions, and defaults.
4. Team template rules: one template's process, quality gates, memory policy, and shared skills.
5. Team instance / project rules: current chat/project conventions, including local `AGENTS.md`, `CLAUDE.md`, data paths, and experiment conventions.
6. Agent role rules: manager/planner/coder/experiment/reviewer boundaries.
7. Worker rules: shared worker execution requirements, plus optional worker label rules such as `worker:nightly`.
8. Task/message rules: temporary requirements for the current task.

Merge rules:

- Each rule records source, version, scope, override policy, target actors, and update time.
- More specific rules can override defaults, but cannot override non-overridable safety or permission rules.
- The compiled Rules Context Pack must include provenance, so operators can debug why an agent received a rule.
- Templates and RuleSets are pinned by version and digest; existing instances do not follow `latest`.
- Project instances can propose rule/template patches through promotion proposals. PMs, users, admins, managers, and agents may create proposals; workers must report candidates back to an agent/manager or PM instead. Only a PM, user, or admin can approve or reject proposals. Approval writes a new template or RuleSet version; existing instances stay pinned until explicitly migrated.
- MetaMemory records design decisions, candidate rules, and approval outcomes, but should not be the only runtime source. Templates and rules need export/import for review and maintenance.

The default global rule for development Bots/Agents/Workers should include:

```text
If you change code or configuration, check whether documentation and corresponding MetaMemory need updates.
If you do not update them, explain why in the final report.
If tests were not run or failed, state that clearly in the final report.
```

## Implementation Plan

Current implementation status:

- Implemented: versioned template store bootstrapped from `bots.json`, template digests, chat/project/global instance resolver, pinned legacy/runtime team metadata, physical `instance_id` columns on Agent/Task/Message/Run rows with backfill and sync, instance-scoped Agent supervisor chat/session IDs for runtime teams, restart recovery cleanup for internal `worker-`, `team:`, and `teaminst:` active-task records, pinned RuleSet refs on runtime instances, explicit RuleSet pinning during `instances resolve`, team config updates for pinned RuleSet refs / quotas / `pmBot`, versioned RuleSet store, RuleSet export/diff/import control surface, promotion proposals with PM/user/admin approval, first-class `agent-role` / `worker` RuleSet selection, Rules Context Pack generation, Rules Context Pack injection for Bot turns, Agent Team runs, and Worker dispatch prompts, PM/admin/user-only agent creation gate, quota enforcement for Agents, temporary Agents, scoped team count, queue backlog, and active runs, temporary Agent TTL recycling, and `instanceId` lookup for existing team routes.
- Implemented CLI/API surface: `metabot teams templates ...`, `metabot teams proposals ...`, `metabot teams instances ...`, and `metabot teams rules ...` including `rules export/diff/import`. Existing `<team>` command positions now accept either a team name or an `instanceId`; prefer `instanceId` for scoped chat/project instances.
- Implemented minimum activity-card lifecycle: `CardState.lifecycleStage` / `lifecycleKey`, Feishu v1/v2 card rendering for non-closed stages, MessageBridge normalization for `received`, `executing`, `recovering`, `blocked`, and `closed`, stable lifecycle-key generation/propagation for normal chat turns, continuation cards, bytheway cards, spontaneous and direct Agent activity cards, scheduled tasks, workers, Agent Team runs, and API tasks, plus a lightweight `SESSION_STORE_DIR/card-lifecycle.json` store keyed by `lifecycleKey`. Agent Team activity cards now persist `teamName`, `instanceId`, `agentName`, `runId`, and `taskIds` metadata when available, and `GET /api/agent-teams/<team>/activity` plus `metabot teams activity <team>` expose filtered history.
- Implemented restart dedupe increment: restart recovery queues continuation tasks with a stable chat-scoped `dedupeKey` (`botName + chatId`), and `TaskScheduler` reuses a pending/executing task with the same key instead of scheduling duplicates; Worker dispatch accepts an explicit `dedupeKey` and reuses a running or recent completed worker for the same `pmChatId + dedupeKey`; final card delivery writes `finalDeliveredAt` / `finalDeliveryStatus` markers on the lifecycle record to avoid duplicate final delivery for the same lifecycleKey.
- Implemented restart recovery hardening: when the bridge starts without a fresh controlled-restart breadcrumb but still finds a non-expired active chat/API task record, it marks the interrupted card as `recovering` and queues a recovery continuation instead of showing `Task interrupted by service restart`.
- Implemented restart preflight guard, checkpoint handshake, and bounded ready timeout: ordinary `/restart service` checks recorded active bot/agent turns and blocks the service restart when other work is still active; blocked/scheduled/forced/timed_out restart requests are recorded in `SESSION_STORE_DIR/restart-requests.json`; blocker chats receive a restart-prepare notice with the same `requestId`, can reply `/restart ready <requestId> [checkpoint note]`, and the requester can retry `/restart service` to reuse the request and schedule once all current blockers are ready. A blocked request has a default 10 minute ready timeout (`METABOT_RESTART_READY_TIMEOUT_MS`); timeout only marks the request `timed_out` and never force-restarts the service. `/restart service --force <reason>` is the explicit override path. Scheduled same-chat restarts preserve the active-task record so restart recovery can queue continuation instead of losing the interrupted turn.
- Implemented config/authority hardening: `loadAppConfig()` preserves supported Agent Team template fields from `bots.json` (`quotas`, `ruleSetRefs`, `pmBot`, scoped instance metadata, and temporary-Agent lifecycle metadata), and the HTTP/CLI surfaces no longer treat missing `actorRole` as PM authority for Agent creation, promotion approval, direct template/rule import, instance resolve, or team config updates. Worker dispatch/abort/redirect API and MCP calls also require explicit PM/user/admin `actorRole` / `actor_role`; controlled service restart rejects manager/agent/worker actor roles.
- Implemented Web UI activity history: the Team tab fetches Agent Team instances and renders Agent Team lifecycle activity through `GET /api/agent-teams/<team>/activity`; selecting a sub-agent filters by `agentName`, while the existing bot task activity remains visible separately.
- Implemented UI lease/checkpoint increment: `card-lifecycle.json` records now include `leaseOwner`, `leaseExpiresAt`, `checkpointNote`, `checkpointBy`, `checkpointAt`, and `restartRequestId`; non-closed cards refresh the lease automatically and closed cards release it. `/restart ready <requestId> [checkpoint note]` writes the blocker checkpoint back to the matching lifecycle record.
- Implemented post-restart readiness reports: after controlled restart recovery, requester and blocker chats receive requestId, status, readiness progress, timed-out state, queued continuations, and affected chats; `reportedAt` dedupes the report.
- Still pending: switching primary coordination keys fully from the legacy `teamName` surface to `instanceId`, plus a broader business-level audit view for instance/run/message dedupe.

Phase 1: Data model and resolver

- Add a template store: `templateId`, `version`, `digest`, `agents`, `sharedPrompts`, `skills`, `workflowPolicy`, `qualityGates`, `ruleSetRefs`.
- Add an instance store: `instanceId`, `templateId`, `templateVersion`, `scopeType`, `scopeKey`, `chatId`, `projectId`, `pmBot`, `status`, `quotas`.
- Move tasks, messages, runs, sessions, chat bindings, and activity cards from `teamName` to `instanceId`.
- Add `resolveTeam(templateName, chatId, projectId, createIfMissing)`.

Phase 2: Template bootstrap and export/import

- Treat `bots.json` only as a bootstrap/template seed.
- Import `agentTeams` into the versioned template store on startup; content changes create a new version.
- Support `metabot teams templates export/import/diff`.
- Store secret references, not secret values, in runtime instances.

Phase 3: Permissions, quotas, and recycling

- Define capability policy for PM, manager, Agent, and Worker.
- Enforce per-chat/project limits for team count, agent count, temporary agents, active runs, queue backlog, and idle TTL. Team count, agent count, temporary agents, active runs, and queue backlog are implemented; idle TTL is handled for temporary Agents.
- Archive or stop expired temporary agents; stop/requeue agents with unfinished work before recycling.
- Let the manager request PM actions, but not create agents, dispatch workers, or restart services directly.

Default quota fields:

| Field | Default | Meaning |
| --- | ---: | --- |
| `maxAgents` | 8 | Active Agents per team instance |
| `maxTemporaryAgents` | 3 | Temporary Agents per team instance |
| `maxParallelRunsPerAgent` | 4 | Concurrent runs per Agent |
| `maxTeamsPerScope` | 3 | Active team instances per chat/project/global scope |
| `maxQueuedTasks` | 64 | Pending or in-progress tasks per team instance |
| `maxActiveRuns` | 16 | Running runs per team instance |

Phase 4: Shared rules compilation

- Add a RuleSet store with version, digest, scope, and export/import.
- Compile Rules Context Packs before Bot turns, Agent runs, and Worker dispatch. Bot turns receive global/bot/task rules, Agent Team runs receive global/team/role/task rules, and Worker dispatch receives global/bot/worker/task rules.
- Log loaded rules and conflict decisions for auditability.

Phase 5: Activity cards and recovery

- Move `displayChatIds` to instances.
- Use a bounded activity-card state machine: received, acknowledged, executing, checkpointing, responding, closed, recovering, blocked. The current bridge has lifecycle fields, Feishu rendering, lifecycle keys on the main card/task paths, a lightweight JSON lifecycle store, lease/checkpoint fields, and Web UI/API/CLI activity history. Agent Team activity records include instance/run/task metadata when available; restart readiness ACK writes the checkpoint note into the matching lifecycle record.
- Before a normal service restart, block if other active turns are recorded and persist the blocker snapshot under a restart `requestId`. Blocker chats receive a restart-prepare notice with the request ID and checkpoint command, and the requester can retry `/restart service` after the blockers acknowledge readiness.
- `/restart status` shows recent persisted restart requests and their first blocker, so operators can inspect blocked restarts from Feishu without reading logs or JSON files directly.
- Blocked participants can acknowledge readiness with `/restart ready <requestId> [checkpoint note]`; the ACK is persisted on the restart request and `/restart status` reports `ready=x/y` progress. The same blocked request is reused on retry so readiness is not lost.
- Blocked restart requests have a bounded ready timeout. When the timeout expires, the request is marked `timed_out`, `/restart status` shows the timeout state, and MetaBot asks the requester to retry after blockers finish or use `/restart service --force <reason>` for an explicit emergency override.
- After restart completes, restart recovery sends a post-restart readiness report to requester and blocker chats; each request is reported once.
- If the bridge is restarted outside the controlled path but a recent active task record still exists, restart recovery now queues a continuation with an explicit "no fresh controlled-restart breadcrumb" reminder instead of failing the card and asking the user to resend.
- Use instance/run/message dedupe keys during restart recovery to avoid duplicate worker dispatches or duplicate final responses. The restart-continuation scheduler path already has a stable dedupe key; Worker dispatch supports caller-provided `dedupeKey` reuse for running/recent completed workers; final delivery uses lifecycle delivery markers to avoid duplicate final delivery for the same lifecycleKey. A later migration should unify these keys and their audit view under the first-class `instanceId` / run / message model.

## CLI Workflow

Use `metabot teams` for all coordination:

```bash
metabot teams create metabot-dev --description "MetaBot implementation team"
metabot teams agents spawn metabot-dev cli-engineer --role implementation --actor-role pm --engine codex --prompt "Own CLI UX, tests, and docs."
metabot teams tasks create metabot-dev "Add runs CLI" --description "Expose runs create/update in bash and TS CLIs." --owner cli-engineer
metabot teams send metabot-dev cli-engineer "Start task 4." --from lead --summary "assign task 4"
```

For scoped runtime teams, first run `metabot teams instances resolve <template> --chat <chatId> --rule-ref <name[@version]>` or inspect `metabot teams instances list`. The returned `instanceId` can be used anywhere the command reference shows `<team>`, for example `metabot teams tasks list ati_...`.

If a project needs new pinned conventions after creation, use `metabot teams config <instanceId> --rule-ref <name[@version]> --pm-bot <name>` and, when needed, explicit quota flags such as `--max-temporary-agents 5`. This updates the current runtime instance without silently following `latest`.

Agents normally start each turn by reading their mailbox and task:

```bash
metabot teams inbox metabot-dev cli-engineer --unread --read
metabot teams tasks get metabot-dev 4
metabot teams tasks update metabot-dev 4 --status in_progress --owner cli-engineer
```

They finish by recording the result and reporting to the lead:

```bash
metabot teams tasks update metabot-dev 4 --status completed --result "Added runs create/update to bash and TS CLI; production smoke passed."
metabot teams send metabot-dev lead "Completed task 4: runs create/update is live." --from cli-engineer --summary "task 4 complete"
```

## Runs

Runs represent background execution records for an agent. They are used by the supervisor and by Feishu card snapshots to show active or completed background work.

```bash
metabot teams runs list metabot-dev
metabot teams runs create metabot-dev --agent cli-engineer --task-id 4 --status running --output "Starting smoke test"
metabot teams runs update metabot-dev <runId> --status completed --output "Smoke passed"
metabot teams runs output metabot-dev <runId>
metabot teams runs stop metabot-dev <runId>
```

Valid run statuses are `running`, `completed`, `failed`, and `stopped`. `metabot teams runs stop` now routes through the supervisor when available: it marks the run `stopped`, asks the bridge to stop the agent chat task, requeues any assigned in-progress tasks to `pending` with a stop note, and suppresses late executor output so a delayed success cannot overwrite the stopped run.

Failed-run handling:

- Manual CLI users should set `--status failed --error "<reason>"` when a run fails.
- The Background activity panel shows failed runs with the run error when present.
- `metabot teams runs output <team> <runId>` returns both `output` and `error`, so the lead can inspect the failure without raw database access.
- The supervisor marks crashed or unsuccessful executions as `failed`, stores the error string, requeues assigned in-progress tasks to `pending` with failure context in `result`, returns the agent to idle, and sends a failure message to `lead` for non-lead agents. The next supervisor tick can pick the task up again; the lead is responsible for deciding whether to let it retry, reassign it, or stop the team.

## Card Display

The bridge builds a team snapshot from the Agent Teams store:

- The **Team** panel shows active agents, their working or idle state, and visible tasks.
- The **Background activity** panel shows runs with status and the latest output or error.
- Task statuses shown on cards are `pending`, `in_progress`, and `completed`; deleted tasks are hidden.

This card state is derived from `/api/agent-teams/<team>` data, so CLI updates immediately affect what the bridge can render.

Cards are scoped by chat binding. A team is shown only in chats listed in the team's `displayChatIds` or `chatIds`; active teams are not shown globally. Agent execution chats such as `team:metabot-dev:cli-engineer` can be listed in `chatIds`, while user-facing Feishu chats should be listed in `displayChatIds`.

## Supervisor Phase

The Agent Team supervisor is a bridge-side loop. When enabled, it scans active teams, finds agents with unread messages or assigned pending tasks, creates a run, marks the agent working, and executes that agent in its own chat session. When the run finishes, it records output or error and messages the lead.

Operational details:

- Disable the loop with `METABOT_AGENT_TEAM_SUPERVISOR=0`.
- Tune the polling interval with `METABOT_AGENT_TEAM_SUPERVISOR_INTERVAL_MS`.
- Set `agentTeamExecutionBot` in `bots.json` or `METABOT_AGENT_TEAM_EXECUTION_BOT` to pin which bridge bot executes agent runs. Use a non-privileged PM/internal worker bot such as `research-pm`; do not rely on registration order when `manager` is first.
- Without an explicit execution bot, the supervisor falls back to `metabot`, then `research-pm`, then the first non-`manager` bot, then the first registered bot.
- Assigned pending tasks are moved to `in_progress` when the supervisor starts the run.
- The supervisor sets the configured session engine for the agent chat, but it does not yet validate per-engine capabilities before dispatching work. Keep resident teams on engines known to work in the local bridge until runtime capability checks or per-engine adapters are added.

## Resident Teams In `bots.json`

This section describes the current implementation. In the target model, `agentTeams` becomes a template seed imported into the versioned template store, not a global runtime team.

CLI-only setup is useful for ad-hoc teams. Resident teams are declared in `bots.json` under `agentTeams` and reconciled into the bridge store on startup. With hot reload enabled, changes to `bots.json` are reconciled automatically; set `METABOT_AGENT_TEAMS_HOT_RELOAD=0` to disable the watcher.

```json
{
  "feishuBots": [
    { "name": "metabot", "engine": "codex", "feishu": { "appId": "...", "appSecret": "..." } }
  ],
  "agentTeamExecutionBot": "metabot",
  "agentTeams": [
    {
      "name": "metabot-dev",
      "description": "MetaBot implementation team",
      "status": "active",
      "chatIds": ["team:metabot-dev:cli-engineer", "team:metabot-dev:runtime-engineer"],
      "displayChatIds": ["oc_feishu_chat_id"],
      "agents": [
        { "name": "cli-engineer", "role": "implementation", "engine": "codex", "prompt": "Own teams CLI, command UX, tests, and docs." },
        { "name": "runtime-engineer", "role": "runtime", "engine": "codex", "prompt": "Own bridge runtime, store, supervisor, and cards." }
      ],
      "tasks": [
        { "id": 8, "subject": "Document Agent Teams workflow", "owner": "cli-engineer", "status": "pending" }
      ]
    }
  ]
}
```

`lead` is not reserved globally. In a top-level team such as `metabot-dev`,
the current user-facing bot can act as the leader, so the team does not need a
separate `lead` member. When no active `lead` member exists, messages sent to
`lead` are treated as leader activity and are pushed to the user-facing Agent
Activity card. A nested or sub-project team may still define an independent
`lead` member; in that case `team:<team>:lead` runs like any other member
session.

Reconciliation behavior:

- Existing configured teams are created or updated by name.
- Configured agents and tasks are upserted.
- If a configured team removes agents while still listing at least one desired agent, missing existing agents are marked `stopped`.
- Teams previously seen in `agentTeams` are marked `managedByConfig`; if they later disappear from config, reconcile marks them `stopped`.
- Manual CLI-created teams are left alone unless they share a configured team name.

Rollout caveat for existing databases: the `managed_by_config` column defaults to false when it is added to an existing Agent Teams DB. Pre-existing resident/config-created teams are not treated as config-managed until the bridge reconciles them once from `bots.json`. After deploying this change, restart the bridge or trigger one hot reload with the desired `bots.json` `agentTeams` still present. Only after that first reconcile should you rely on removing a team from `agentTeams` as a rollback mechanism to stop an old resident team.

## Command Reference

```bash
metabot teams list
metabot teams create <team> [--description <text>]
metabot teams delete <team>
metabot teams status <team>
metabot teams start <team>
metabot teams stop <team>

metabot teams agents list <team>
metabot teams agents spawn <team> <name> [--role <agent-role>] [--actor-role admin|user|pm] [--engine claude|codex|kimi] [--prompt <text>]
metabot teams agents stop <team> <name>
metabot teams agents delete <team> <name>

metabot teams send <team> <to> <message> [--from <name>] [--summary <text>]
metabot teams inbox <team> <name> [--unread] [--read]

metabot teams tasks list <team>
metabot teams tasks create <team> <subject> [--description <text>] [--owner <name>]
metabot teams tasks get <team> <id>
metabot teams tasks update <team> <id> [--status pending|in_progress|completed|deleted] [--owner <name>] [--result <text>]

metabot teams runs list <team>
metabot teams runs create <team> [--agent <name>] [--task-id <id>] [--status running|completed|failed|stopped] [--output <text>] [--error <text>]
metabot teams runs update <team> <runId> [--status running|completed|failed|stopped] [--output <text>] [--error <text>]
metabot teams runs output <team> <runId>
metabot teams runs stop <team> <runId>
```

## Current Limits

- Agent Teams is local-bridge state, not metabot-core state. Use it from the bridge host or configure `METABOT_URL` and `API_SECRET` for remote access.
- Engine-neutral coordination does not mean universal execution support. Agent engines are selected through the current bridge/session-engine boundary.
- The supervisor can execute agents, but the lead still owns integration quality and final user reporting.
- `runs stop` requests cancellation through the bridge supervisor and requeues assigned tasks, but cancellation still depends on the active engine task honoring the bridge stop signal.
- Runs store text output and error strings; large artifacts should still go through the normal output-file path.

## See Also

- [metabot CLI](../reference/cli-metabot.md) — full CLI reference
- [MetaSkill](metaskill.md) — generate team prompts and skills before running
- [Goal Loops](goal-loops.md) — give the team a longer-running objective
- [Peers](peers.md) — route work across MetaBot instances
