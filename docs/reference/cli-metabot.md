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
metabot update                                  # package install: latest GitHub Release
metabot update --package                        # force latest GitHub Release package
metabot update --package --version 1.3.0        # pin immutable Release v1.3.0
metabot update --git                            # force git pull + rebuild + restart
metabot start                       # start Bridge + Worker Runner + ARC
metabot stop                        # stop the whole three-app runtime
metabot restart                     # coordinated Bridge restart
metabot restart --bot admin --chat oc_x --reason "upgrade"  # report back to a chat
metabot restart --no-resume         # notify, but do not queue interrupted turns
metabot restart --force             # emergency override if prepare cannot complete
metabot restart --wait --json       # protected Bridge-only restart
metabot restart --request-id ID     # caller-stable idempotency key
metabot restart --force             # emergency override if chat preparation fails
metabot restart --daemon worker     # guarded Worker Runner restart
metabot deploy-runtime --runtime /absolute/checkout --wait  # protected external runtime switch
metabot logs                        # view live logs (pass -n 100 etc.)
metabot status                      # PM2 process status
```

For a normal package-managed personal edition, `metabot update` defaults to the
latest GitHub Release. A source checkout is auto-detected and keeps its Git
update path; use `--package` to force a Release overlay.

`metabot update --package --version 1.3.0` selects the immutable v1.3.0 assets
instead of `latest`. Package updating performs:

1. Download `install.sh`, `metabot-runtime.tgz`, and `SHA256SUMS` from the latest or pinned GitHub Release.
2. Verify the runtime SHA256 before extraction.
3. Validate the complete personal-edition manifest and its semantic version; a pinned version must match exactly.
4. Overlay code into `METABOT_HOME`, preserving `.env`, `bots.json`, `logs/`, `data/`, and `.git/`.
5. Preserve user/Core state under `~/.metabot/` and `~/.metabot-core/`; only package-owned `~/.metabot/default.env` may be refreshed.
6. Install dependencies and build the Bridge, Core, Web UI, and delegated CLI.
7. Refresh bundled/workspace Skills and existing Lark CLI Skills when present.
8. Restart Bridge and both execution daemons, then save PM2 only after health.

Plain `restart` accepts `--request-id`, `--bot`, `--chat`, `--source`,
`--reason`, `--resume`/`--no-resume`, `--wait`, `--timeout`, `--force`, and `--json`.
`deploy-runtime` accepts the same request metadata plus `--wait`/`--no-wait`
and `--force`. A repeated request ID reads the existing durable result and
does not repeat the PM2 action.

The old Bridge process writes an atomic breadcrumb and a transactional SQLite
request record, then changes only the registered `metabot` process in place.
The new Bridge verifies its HTTP health, both execution-daemon wire probes,
and the expected PM2 cwd, script, interpreter, interpreter arguments, and
environment before it runs `pm2 save --force` and marks the request healthy.
Environment values, including credentials and proxy settings, are stored in
the restart ledger only as SHA-256 fingerprints. The breadcrumb is retained until reporting and continuation
ownership are recorded, preventing a recovered session from starting a
restart loop.

Before that durable PM2 transition, the authenticated local Bridge briefly
quiesces every registered bot and snapshots all active chats. Each affected
user-facing chat receives a **Restart Preparing** notice from its own bot. A
notification failure cancels the restart and releases the quiesce unless the
operator explicitly passes `--force`. A two-minute preparation lease also
unfreezes the Bridge if the controller disappears before changing PM2 state.
When the CLI runs inside a signed engine session, it forwards that scoped
capability instead of the Bridge administrator secret. Only `user`, `pm`, or
`admin` roles may prepare or cancel a restart, and only for the exact signed
bot and chat; Agent Team agents and workers remain denied.

When `--resume` has a normal user or PM bot/chat scope, startup schedules one
durable continuation for every interrupted user-facing chat, not just the
requester, so each affected bot continues exactly once and sends its own
**Restart Complete** notice. The scheduler writes each task atomically before
it arms the timer; a persistence or completion-notice failure retains the
restart breadcrumb for the next startup replay. Non-card Agent Bus work is
resumed without attempting to send to synthetic chat IDs. Agent Team and Worker/ARC internal chats are not
generically resumed; their durable supervisors and daemons remain responsible
for recovery. Restart state is under `SESSION_STORE_DIR`, `METABOT_STATE_DIR`,
or `~/.metabot/` (`restart-state.sqlite`, `controlled-restart.json`, and
`last-restart.json`). This addition does not migrate `sessions.db`.

Daemon restarts refuse while work is active. `--force` explicitly accepts that
ambiguous in-flight work can become `recovery_required`. `deploy-runtime` has
the same guard and must run outside the MetaBot process tree. It prevalidates
the live Bridge PID and the caller ancestry; if either cannot be read, it
refuses the switch instead of assuming the caller is external. It then
prevalidates the target/rollback configurations, restarts Worker Runner, ARC, an optional
checkout-owned local Core, then Bridge without deleting their PM2
registrations, and rolls back every changed app if PM2 rejects or cannot verify
a switch. Core stays in its separate ecosystem. It is included only when its
current PM2 cwd/script exactly match the Bridge runtime; an external Core is
left untouched. `uninstall.sh` uses the same ownership check. Only the healthy
new Bridge saves the process list.

Package updates of an online runtime must be launched from SSH or another
controller outside the live Bridge process tree. The updater refuses internal
or unverifiable callers before downloading the package, then uses the same
request-ID-backed no-delete runtime switch. Initial or offline installation
may start missing registrations, but never deletes an existing registration.

Override the package installer mirror with `METABOT_UPDATE_INSTALLER_URL`.
`--version` accepts only `x.y.z` (an optional leading `v` is normalized) and
cannot be combined with `--git`.

### Coordinated restart

`metabot restart` first asks the authenticated local Bridge to prepare. The
Bridge briefly stops accepting new work, snapshots every active task across
all registered bots, and sends a **Restart Preparing** notice to each affected
chat using that bot's own channel identity. If any affected chat cannot be
notified, the restart is cancelled and normal work is unfrozen. `--force` is
the explicit emergency override.

After PM2 starts the new Bridge, each affected bot updates its interrupted
card, sends a **Restart Complete** notice, and queues exactly one continuation
turn. A stable `--request-id` deduplicates retries. `--bot` plus `--chat` also
reports the result to an idle requester chat; idle bots without a destination
chat are not sent unsolicited messages.

The handoff is stored atomically under `SESSION_STORE_DIR` (normally
`~/.metabot/`) in `controlled-restart.json` and `last-restart.json`. It does not
modify the session database. If PM2 rejects the restart, the CLI cancels the
Bridge's prepare state and removes the breadcrumb before returning an error.

## 2. Bridge daemon API

These commands curl the local bridge daemon at `localhost:9100`, reading
`API_PORT` / `API_SECRET` (and optional `METABOT_URL`) from the bridge `.env`.
Human or local management mutations require `API_SECRET`, including on
loopback; the Bridge does not restore unauthenticated local mutation access.
An Agent Team engine session instead forwards its short-lived scoped
credential for only `metabot bots`, `metabot peers`, `metabot stats`, and
`metabot metrics`, plus same-Bot `metabot agents talk` and `talk-status`,
outside the Team coordination API. It never forwards
`API_SECRET` or `METABOT_API_SECRET`, and the scoped credential cannot read bot
details/profiles or call other Bridge routes. The Bridge derives and injects
`METABOT_ENGINE_BRIDGE_URL` from its actual loopback listener; the peer
advertisement URL is not trusted for capability delivery.

### Bot management

```bash
metabot bots                        # list all bots (local + peer)
metabot bot <name>                  # get bot details
```

### Agent talk

```bash
metabot talk <bot> <chatId> <prompt>      # talk to a bot (bridge /api/talk)
metabot talk alice/bot <chatId> <prompt>  # talk to a specific peer's bot
metabot agents talk <sameBot> <chatId> <prompt> --async --cards
metabot agents talk-status <taskId>
```

The bot name supports [qualified names](../features/peers.md#qualified-names)
(`peerName/botName`) for cross-instance routing. This is the operator-facing
bridge-local talk path. `metabot agents talk` is the normal Agent Bus command:
a signed engine session sends the same Bot to another chat asynchronously,
forces a target-chat card, and receives a task/card receipt without using the
Bridge administrator secret. Delegated task receipts use full UUID task IDs,
and `talk-status` requires the exact signed source Bot/Chat fields and rejects
malformed IDs, inconsistent target fields, time order, or result lifecycles.
If that Bot is not local, the signed path returns not-found instead of looking
for a same-named peer.
CLI-only and remote targets retain the central
inbox relay. Protected remote targets remain fail-closed until their sender
Bridge can attach an authenticated dispatch and explicit target grant.

### Peers

```bash
metabot peers                       # list peers and status
```

### Agent Teams

`metabot teams` talks to the local bridge `/api/agent-teams/*` API. It is the coordination surface for MetaBot Agent Teams: agents, mailbox messages, shared tasks, and background runs.

Governed Teams add separate versioned resources without changing legacy or
`bots.json` Teams:

```bash
metabot teams templates list
metabot teams templates publish implementation --body '{"agents":[{"name":"coder","engine":"codex"}]}'
metabot teams rules publish implementation-policy --scope team-template --rules '[{"text":"Keep changes focused."}]'
metabot teams instances resolve implementation --scope project --scope-key project-a --pm-bot metabot
metabot teams instances stop atg_0123456789abcdef
metabot teams audit --instance atg_0123456789abcdef
```

Chat scope is the default. Global scope requires the explicit `--global`
option. Engine sessions automatically forward a short-lived bridge-issued
credential and do not inherit the bridge administrator secret. Persistent
executor retirement begins before that credential expires, waits for an active
turn to finish, and provides a fresh credential on the next turn. Callers
cannot gain authority with body or CLI role fields.

```bash
metabot teams list
metabot teams create <team> [--description <text>]
metabot teams status <team>
metabot teams start <team>
metabot teams stop <team>
metabot teams delete <team>

metabot teams agents list <team>
metabot teams agents spawn <team> <name> [--role <role>] [--engine claude|codex|kimi] [--model <model>] [--prompt <text>]
metabot teams agents stop <team> <name>
metabot teams agents delete <team> <name>

metabot teams send <team> <to> <message> [--from <name>] [--summary <text>]
metabot teams inbox <team> <name> [--unread] [--read]

metabot teams tasks list <team>
metabot teams tasks create <team> <subject> [--description <text>] [--owner <name>]
metabot teams tasks get <team> <id>
metabot teams tasks update <team> <id> [--status pending|in_progress|completed|failed|deleted] [--owner <name>] [--result <text>]

metabot teams runs list <team>
metabot teams runs create <team> [--agent <name>] [--task-id <id>] [--status running|completed|failed|stopped] [--output <text>] [--error <text>]
metabot teams runs update <team> <runId> [--status running|completed|failed|stopped] [--output <text>] [--error <text>]
metabot teams runs output <team> <runId>
metabot teams runs stop <team> <runId>
```

`runs stop` marks the run `stopped` and, when the bridge supervisor owns the in-flight run, asks the bridge to stop that teammate chat task, requeues assigned in-progress tasks to `pending`, and suppresses late executor output for that stopped run.

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

When the target chat is busy, scheduled work remains pending with persisted
exponential backoff for up to 30 minutes. A bridge restart preserves the
remaining retry window. Exhausted recurring occurrences are logged without a
repeated failure card; an exhausted one-time task sends one failure notice.

### Stats, metrics & health

```bash
metabot stats                       # cost & usage statistics
metabot metrics                     # Prometheus metrics
metabot health                      # health check
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

| Flag              | Description                                                           |
| ----------------- | --------------------------------------------------------------------- |
| `--play`          | Play audio after generating (macOS: afplay, Linux: mpv/ffplay/play)   |
| `-o FILE`         | Save to specific file (default: `/tmp/metabot-voice-<timestamp>.mp3`) |
| `--provider NAME` | TTS provider: `doubao`, `openai`, or `elevenlabs`                     |
| `--voice ID`      | Voice/speaker ID (provider-specific)                                  |

### Strict artifact mirrors

```bash
metabot artifacts status --config /absolute/path/artifact-mirror.json
metabot artifacts sync --config /absolute/path/artifact-mirror.json --apply
metabot artifacts publish --config /absolute/path/artifact-mirror.json \
  --project project-alpha --file /absolute/path/annotations/marked.pdf \
  --name project-alpha_review-tech_topic-annotations_lang-en_20260821_v01.pdf --apply
```

`status` is read-only. `sync --apply` strictly restores the configured local
deliverables payload from its authority after preserving rollback bytes and
local edits. `publish` is the explicit annotations-to-authority path and never
overwrites different bytes.

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
