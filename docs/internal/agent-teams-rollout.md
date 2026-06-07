# MetaBot Agent Teams Rollout Guide

Publication status: checked in as internal release/announcement material and published to Meta Memory.

## Publish Targets

- Meta Memory: create a shared tutorial named `MetaBot Agent Teams Rollout Guide`.
- Docs: keep the operator-facing canonical guide at `docs/features/agent-teams.md`.
- CLI reference: keep command syntax in `docs/reference/cli-metabot.md`.
- Bot skill: keep concise operating instructions in `src/skills/metabot-team/SKILL.md`.

## Short Announcement

MetaBot Agent Teams let a lead agent coordinate a persistent team of specialist members through the local bridge. A lead can create a team, assign tasks, send mailbox messages, and inspect member runs through `metabot teams`. Resident teams can also be declared in `bots.json` and reconciled by the bridge supervisor.

Use this when work needs parallel specialists, review loops, or async member execution that should surface in Agent Activity cards.

## Quickstart

Create a team and members:

```bash
metabot teams create metabot-dev --description "MetaBot implementation team"
metabot teams agents spawn metabot-dev cli-engineer --role implementation --engine codex --prompt "Own teams CLI, command UX, tests, and docs."
metabot teams agents spawn metabot-dev runtime-engineer --role runtime --engine codex --prompt "Own bridge runtime, store, supervisor, and cards."
metabot teams bind metabot-dev <feishu-chat-id> --display
```

Create and assign work:

```bash
metabot teams tasks create metabot-dev "Add teams CLI docs" --owner cli-engineer --description "Update docs and smoke tests."
metabot teams send metabot-dev cli-engineer "Start task 1 and report back to lead." --from lead --summary "assign task 1"
```

Member workflow:

```bash
metabot teams inbox metabot-dev cli-engineer --unread --read
metabot teams tasks get metabot-dev 1
metabot teams tasks update metabot-dev 1 --status in_progress --owner cli-engineer
metabot teams tasks update metabot-dev 1 --status completed --result "Docs updated and verified."
metabot teams send metabot-dev lead "Completed task 1: Docs updated and verified." --from cli-engineer --summary "task 1 complete"
```

Inspect or stop background runs:

```bash
metabot teams runs list metabot-dev
metabot teams runs output metabot-dev <runId>
metabot teams runs stop metabot-dev <runId>
```

`runs stop` routes through the supervisor when available: it marks the run stopped, asks the bridge to stop the member chat task, requeues assigned in-progress tasks to `pending` with a stop note, and suppresses late executor output.

## Top-Level Leader Semantics

- The lead owns planning, assignment, and final user-facing synthesis.
- For a top-level team, the current user-facing bot can be the leader; `metabot-dev` does not require a separate `lead` member.
- `lead` is not globally reserved. Nested or sub-project teams may define a normal `lead` member, which runs in `team:<team>:lead`.
- If no active `lead` member exists, messages sent to `lead` are surfaced as Agent Activity in the configured display chats.
- Teammates should coordinate through `metabot teams`, not plain chat output.
- Lead messages should be concise but self-contained: include task id, owner, constraints, expected result, and verification.
- The lead remains responsible for integrating teammate output before reporting to the user.
- A lead can wake from member messages and send a user-facing Agent Activity summary when member work completes.

## Async Member Workflow

Resident supervisor behavior:

- Scans active teams for agents with unread messages or assigned pending tasks.
- Creates a run and marks the agent `working`.
- Moves assigned pending tasks to `in_progress`.
- Executes the member in chat `team:<team>:<agent>`.
- Records partial output, final output, or error on the run.
- On success, marks assigned tasks completed with the response text.
- On failure or crash, marks the run failed and requeues assigned in-progress tasks to `pending` with failure context.
- For non-lead members, sends a completion or failure message back to `lead`.

Use `metabot teams runs list` and `metabot teams runs output` when a lead needs to inspect background work.

## Resident Team Configuration

Use `bots.json` `agentTeams` for persistent teams:

```json
{
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
        { "id": 1, "subject": "Smoke Agent Teams", "owner": "cli-engineer", "status": "pending" }
      ]
    }
  ]
}
```

Use `chatIds` for member execution chats and `displayChatIds` for user-facing chats where Team and Background card sections should appear.

## Known Caveats

- Agent Teams state is local bridge state, not metabot-core state.
- Coordination is engine-neutral, but execution still goes through the current bridge/session-engine boundary. Use engines known to work on the local bridge until per-engine capability validation is added.
- Card display is chat-scoped by `displayChatIds` / `chatIds`; active teams are not displayed globally.
- Existing Feishu activity cards are immutable from the user's point of view; the supervisor emits a concise idle digest when a team drains all work instead of relying on stale cards to update in place.
- Large artifacts should still use the normal output-file path instead of run output text.
- On existing DBs, `managed_by_config` defaults false until a resident team is reconciled from `bots.json` once. After deploying the migration, restart or hot-reload once with the desired `agentTeams` present before relying on config-removal rollback to stop old resident teams.
- If the supervisor is disabled with `METABOT_AGENT_TEAM_SUPERVISOR=0`, CLI-created tasks and messages remain visible, but members will not be auto-executed.

## Rollout Checklist

1. Deploy the feature branch and restart the bridge.
2. Confirm `metabot teams --help` lists teams, agents, tasks, runs, and bindings.
3. Configure one small resident team in `bots.json`.
4. Restart or hot-reload once with desired `agentTeams` present.
5. Run a smoke task assigned to a non-lead member.
6. Confirm the lead receives the member completion message.
7. Confirm Agent Activity / Team card visibility appears only in configured display chats.
8. Test rollback by removing the resident team from `agentTeams` after the one-time reconcile and confirm it becomes stopped.

## User-Facing Prompt Example

```text
Set up an Agent Team for this feature. You are the top-level lead. Use cli-engineer for CLI/docs, runtime-engineer for bridge behavior, and reviewer-codex for review. Assign each member a task, wait for their reports through metabot teams, then give me one integrated result.
```
