# metabot CLI

`metabot` is the single MetaBot CLI binary. It has three command categories:

1. **Bridge process control** — manage the local MetaBot service lifecycle.
2. **Bridge daemon API** — curl the local bridge daemon at `localhost:9100`.
3. **metabot-core delegation** — forward to the central feature CLI.

## Installation

Installed automatically by the MetaBot installer to `~/.local/bin/metabot`.

> The legacy `mb` / `mm` / `mh` CLIs have been removed. Install and update
> actively delete any leftover binaries from `~/.local/bin/`; if a script
> still calls them you'll see `command not found` — switch the call to
> `metabot <subcommand>`.

## 1. Bridge process control

```bash
metabot update                      # refresh from internal package, rebuild, update skills, restart
metabot update --git                # developer-only: git pull + rebuild + restart
metabot start                       # start with PM2
metabot stop                        # stop
metabot restart                     # restart
metabot restart --wait              # restart current runtime and wait for durable health
metabot deploy-runtime --runtime DIR [--request-id ID] # atomically switch runtime externally
metabot logs                        # view live logs (pass -n 100 etc.)
metabot status                      # PM2 process status
```

`restart` never switches `cwd` or the script target. Runtime/worktree switching
must use `deploy-runtime` from outside the MetaBot process tree. Never run
`pm2 delete metabot` followed by `pm2 start`: deleting the app also kills the
Bot/Agent/Worker shell that would have issued the second command. Restart state
is persisted by `requestId`; callers can reuse that ID to make deployment
retries idempotent. The new process verifies bridge and Anthropic
connectivity, saves PM2 only after health passes, and reports `healthy` or
`failed` through restart recovery.

`metabot update` is the recommended way to update MetaBot. It performs:

1. Download the current internal package from `METABOT_CORE_URL/install/latest.tgz`
2. Overlay code files into `METABOT_HOME`, preserving `.env`, `bots.json`, `logs/`, `data/`, and `.git/`
3. `npm install && npm run build` — rebuild
4. Copy bundled MetaBot skills into Claude/Codex skill directories
5. If `lark-cli` or lark skills are already installed, update `@larksuite/cli` and refresh the lark AI Agent skills
6. Sync skills into the configured bot workspace
7. A requestId-deduplicated atomic PM2 restart; the new process saves PM2 only after health passes

All in one command. Source checkouts can still use `metabot update --git`, but that is a developer-only path and requires a clean Git remote.

## 2. Bridge daemon API

These commands curl the local bridge daemon at `localhost:9100`, reading
`API_PORT` / `API_SECRET` (and optional `METABOT_URL`) from the bridge `.env`.

### Bot management

```bash
metabot bots                        # list all bots (local + peer)
metabot bot <name>                  # get bot details
```

### Agent talk

```bash
metabot talk [--async|--sync] [--no-cards] [--wait-ms N] <bot> <chatId> <prompt>      # talk to a bot (bridge /api/talk)
metabot talk-status <taskId>        # check an async talk task with local auth
metabot talk alice/bot <chatId> <prompt>  # talk to a specific peer's bot
```

The bot name supports [qualified names](../features/peers.md#qualified-names)
(`peerName/botName`) for cross-instance routing. This is the bridge-local talk
path; `metabot agents talk` is the separate central-registry P2P variant.
`metabot talk` waits up to 25 seconds by default; if the task is still running,
it returns a `taskId` and `statusCommand` instead of blocking indefinitely. Use
`--sync` for the old blocking behavior, or `--async` to return immediately.
Async talk responses include a `statusUrl` for API clients and a
`statusCommand` such as `metabot talk-status <taskId>` for local CLI users.
Async task status is persisted under `SESSION_STORE_DIR`; if the bridge restarts
while a task is running, the old task id should return `failed` with
`task_interrupted_by_restart` instead of disappearing as `Task not found`.

### Peers

```bash
metabot peers                       # list peers and status
```

### Agent Teams

`metabot teams` talks to the local bridge `/api/agent-teams/*` API. It is the coordination surface for MetaBot Agent Teams: agents, mailbox messages, shared tasks, and background runs.

```bash
metabot teams list
metabot teams create <team> [--description <text>] [--actor-role admin|user|pm]
metabot teams status <team>
metabot teams bind <team> <chatId> [--display] [--actor-role admin|user|pm]
metabot teams start <team> [--actor-role admin|user|pm]
metabot teams stop <team> [--actor-role admin|user|pm]
metabot teams delete <team> [--actor-role admin|user|pm]

metabot teams config <team> [--chat <id,id>] [--display-chat <id,id>] [--pm-bot <name>] [--rule-ref <name[@version],...>] [--max-agents <n>] [--max-temporary-agents <n>] [--max-parallel-runs <n>] [--max-teams-per-scope <n>] [--max-queued-tasks <n>] [--max-active-runs <n>] [--actor-role admin|user|pm]
metabot teams activity <team> [--agent <name>] [--run-id <id>] [--task-id <id>] [--chat <chatId>] [--source <name>] [--limit <n>] [--summary|--plain]
metabot teams templates list [name]
metabot teams templates export <name> [--version <n>]
metabot teams templates diff <name> --from <n> [--to <n>]
metabot teams templates import '<json>' [--source <name>] [--actor-role admin|user|pm]
metabot teams proposals list [--status pending|approved|rejected]
metabot teams proposals create [template|ruleset] '<json>' [--summary <text>] [--by <name>] [--role admin|user|pm|manager|agent]
metabot teams proposals approve <id> [--by <name>] [--actor-role admin|user|pm] [--reason <text>]
metabot teams proposals reject <id> [--by <name>] [--actor-role admin|user|pm] [--reason <text>]
metabot teams instances list [--template <name>]
metabot teams instances resolve <template> [--chat <chatId>|--project <projectId>|--global] [--pm-bot <name>] [--rule-ref <name[@version]>] [--actor-role admin|user|pm]
metabot teams rules list [name]
metabot teams rules export <name> [--version <n>]
metabot teams rules diff <name> --from <n> [--to <n>]
metabot teams rules import '<json>' [--source <name>] [--actor-role admin|user|pm]
metabot teams rules set <name> --scope global|bot|team-template|team-instance|project|agent-role|worker|task --rule <text> [--actor-role admin|user|pm]
metabot teams rules context --ref <name[@version]> [--rule <text>]

metabot teams agents list <team>
metabot teams agents spawn <team> <name> [--role <agent-role>] [--actor-role admin|user|pm] [--engine claude|codex|kimi] [--model <model>] [--reasoning-effort <level>] [--approval-policy <policy>] [--sandbox <mode>] [--timeout-ms <n>] [--idle-timeout-ms <n>] [--allowed-tools <a,b>] [--prompt <text>]
metabot teams agents stop <team> <name> [--actor-role admin|user|pm]
metabot teams agents delete <team> <name> [--actor-role admin|user|pm]

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
metabot teams runs stop <team> <runId> [--actor-role admin|user|pm]
```

`runs stop` marks the run `stopped` and, when the bridge supervisor owns the in-flight run, asks the bridge to stop that agent chat task, requeues assigned in-progress tasks to `pending`, and suppresses late executor output for that stopped run.

Template/rule commands are the Phase 1 control surface for versioned Agent Team templates, chat/project-scoped runtime instances, pinned RuleSet refs, versioned RuleSets, and promotion proposals. Managers or agents can create proposal records, but only a PM, user, or admin can approve or reject them; approval writes a new template or RuleSet version and does not auto-upgrade pinned instances. `instances resolve --rule-ref ...` pins extra project/runtime RuleSets at creation time, `teams config ... --rule-ref ...` updates the current instance explicitly, and `rules export/diff/import` gives RuleSets the same reviewable lifecycle as templates. Existing `<team>` arguments accept either a team name or an `instanceId`; prefer the `instanceId` returned by `instances resolve` for scoped project/chat teams. The storage schema still keeps rows under `teamName` while the runtime migrates toward first-class `instanceId` internally.

For privileged CLI actions, `--actor-role` is the caller authority (`admin`, `user`, or `pm`). It is required for team lifecycle changes, binding/config updates, direct Agent creation or stop/delete, run stop, direct template/rule import or set, instance resolve, and promotion decisions. `--role` on `agents spawn` is the spawned Agent's functional role, not authority.

The same command surface is implemented in both `bin/metabot` and the TypeScript feature CLI under `packages/cli`. The bridge reads `API_PORT` / `API_SECRET` and optional `METABOT_URL` from `.env`.

### Scheduling

```bash
metabot schedule list                                          # list all tasks
metabot schedule cron <bot> <chatId> '<cron>' <prompt>         # create recurring task
metabot schedule add <bot> <chatId> <delaySec> <prompt>        # create one-time task
metabot schedule pause <id>                                    # pause a task
metabot schedule resume <id>                                   # resume a task
metabot schedule cancel <id>                                   # cancel a task
```

### Stats, metrics & health

```bash
metabot stats                       # cost & usage statistics
metabot metrics                     # Prometheus metrics
metabot health                      # health check
metabot doctor --json               # runtime diagnostics, including Codex sandbox namespace readiness
```

### Voice

```bash
metabot voice call <bot> <chatId> [prompt] [-w opening]  # start an RTC voice call
metabot voice transcript <sessionId>                     # get call transcript
metabot voice list                                       # list active voice sessions
metabot voice config                                     # check RTC configuration
metabot voice tts "Hello world"                          # generate MP3, print file path
metabot voice tts "Hello" --play                         # generate and play audio
metabot voice tts "Hello" -o greeting.mp3                # save to specific file
echo "Long text" | metabot voice tts                     # read from stdin
metabot voice tts "Hello" --provider doubao              # use specific TTS provider
metabot voice tts "Hello" --voice nova                   # use specific voice
```

TTS flags:

| Flag | Description |
|------|-------------|
| `--play` | Play audio after generating (macOS: afplay, Linux: mpv/ffplay/play) |
| `-o FILE` | Save to specific file (default: `/tmp/metabot-voice-<timestamp>.mp3`) |
| `--provider NAME` | TTS provider: `doubao`, `openai`, or `elevenlabs` |
| `--voice ID` | Voice/speaker ID (provider-specific) |

## 3. metabot-core delegation

Any subcommand not listed above is forwarded to the metabot-core feature CLI
(`packages/cli/bin/metabot`):

```bash
metabot t5t board                   # team standup board
metabot agents list                 # peer-bot directory
metabot memory search "<query>"     # shared-memory full-text search
metabot skills list                 # central Skill Hub
```

`METABOT_CORE_URL` / `METABOT_CORE_TOKEN` are fed from the bridge `.env` when
not already exported. Override the CLI path with
`export METABOT_CORE_CLI=/path/to/packages/cli/bin/metabot`.

## Remote Access

By default, the bridge daemon API connects to `http://localhost:9100`. For
internet-reachable deployments, point it at your HTTPS reverse proxy. If you use
a private network such as Tailscale or WireGuard, you can use that private
address instead.

```bash
# Generate a secret once: openssl rand -hex 32
# In ~/.metabot/.env or ~/metabot/.env
METABOT_URL=http://your-server:9100
API_SECRET=your-secret
```
