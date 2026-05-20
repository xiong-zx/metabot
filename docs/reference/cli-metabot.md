# metabot CLI

`metabot` is the single MetaBot CLI binary. It has three command categories:

1. **Bridge process control** — manage the local MetaBot service lifecycle.
2. **Bridge daemon API** — curl the local bridge daemon at `localhost:9100`.
3. **metabot-core delegation** — forward to the central feature CLI.

## Installation

Installed automatically by the MetaBot installer to `~/.local/bin/metabot`.

> The legacy `mb` command is now a thin deprecation wrapper that forwards to
> `metabot`. `mb skills` maps to `metabot bot-skills`; everything else forwards
> verbatim. Update your scripts to call `metabot` directly.

## 1. Bridge process control

```bash
metabot update                      # pull latest code, rebuild, update skills, restart
metabot start                       # start with PM2
metabot stop                        # stop
metabot restart                     # restart
metabot logs                        # view live logs (pass -n 100 etc.)
metabot status                      # PM2 process status
```

`metabot update` is the recommended way to update MetaBot. It performs:

1. `git pull` — fetch latest code
2. `npm install && npm run build` — rebuild
3. Copy bundled MetaBot skills into Claude/Codex skill directories
4. If `lark-cli` or lark skills are already installed, update `@larksuite/cli` and refresh the lark AI Agent skills
5. Sync skills into the configured bot workspace
6. `pm2 restart` — restart the service

All in one command.

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
metabot talk <bot> <chatId> <prompt>      # talk to a bot (bridge /api/talk)
metabot talk alice/bot <chatId> <prompt>  # talk to a specific peer's bot
```

The bot name supports [qualified names](../features/peers.md#qualified-names)
(`peerName/botName`) for cross-instance routing. This is the bridge-local talk
path; `metabot agents talk` is the separate central-registry P2P variant.

### Peers

```bash
metabot peers                       # list peers and status
```

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

### Per-bot Skill Hub

```bash
metabot bot-skills list                          # list all skills (local + peer)
metabot bot-skills search <query>                # search skills by keyword
metabot bot-skills get <name>                    # get skill details
metabot bot-skills publish <botName> <skillName> # publish a bot's skill to the hub
metabot bot-skills install <skillName> <botName> # install a skill to a bot
metabot bot-skills remove <name>                 # unpublish a skill
```

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
