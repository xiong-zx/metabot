<div align="center">

# 🤖 MetaBot

### Control Claude Code, Kimi Code, or Codex CLI from your phone via Feishu / Telegram / WeChat

*Write code · Manage agents · Automate everything*

<p>
  <a href="https://github.com/xiong-zx/metabot"><img src="https://img.shields.io/badge/GitHub-Repo-181717?style=for-the-badge&logo=github&logoColor=white" alt="GitHub"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="License"></a>
</p>

<p>
  <a href="https://github.com/anthropics/claude-code"><img src="https://img.shields.io/badge/Engine-Claude_Code-D97757?style=for-the-badge&logo=anthropic&logoColor=white" alt="Claude Code"></a>
  <a href="https://platform.moonshot.ai"><img src="https://img.shields.io/badge/Engine-Kimi_Code-1A73E8?style=for-the-badge&logoColor=white" alt="Kimi Code"></a>
  <a href="https://github.com/openai/codex"><img src="https://img.shields.io/badge/Engine-Codex_CLI-412991?style=for-the-badge&logo=openai&logoColor=white" alt="Codex CLI"></a>
  <img src="https://img.shields.io/badge/Subscription-Native-22C55E?style=for-the-badge&logo=key&logoColor=white" alt="Native Subscription">
  <img src="https://img.shields.io/badge/Node.js-20+-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js">
</p>

<p>
  <a href="https://feishu.cn"><img src="https://img.shields.io/badge/Feishu_/_Lark-00D6B9?style=for-the-badge&logo=lark&logoColor=white" alt="Feishu/Lark"></a>
  <a href="https://telegram.org"><img src="https://img.shields.io/badge/Telegram-26A5E4?style=for-the-badge&logo=telegram&logoColor=white" alt="Telegram"></a>
  <a href="https://ilinkai.weixin.qq.com"><img src="https://img.shields.io/badge/WeChat_ClawBot-07C160?style=for-the-badge&logo=wechat&logoColor=white" alt="WeChat"></a>
  <img src="https://img.shields.io/badge/Web_UI-61DAFB?style=for-the-badge&logo=react&logoColor=white" alt="Web UI">
</p>

[中文](README.md) · **English** · [📚 Docs](docs/)

</div>

> **Claude Code**, **Kimi Code**, and **Codex CLI** — three first-class engines. Subscription or API key, your choice. Each bot picks its own engine.

<div align="center">
<table>
<tr>
  <td width="25%"><img src="resources/demo-1.png" alt="Spawn an agent team" /></td>
  <td width="25%"><img src="resources/demo-2.png" alt="Dispatch a task" /></td>
  <td width="25%"><img src="resources/demo-3.png" alt="Agents working between turns" /></td>
  <td width="25%"><img src="resources/demo-4.png" alt="PR merged" /></td>
</tr>
</table>
<sub>Feishu mobile · Spawn a team · Dispatch a task · Watch progress · PR merged</sub>
</div>

```bash
git clone https://github.com/xiong-zx/metabot.git ~/metabot
cd ~/metabot && bash install.sh
```

The installer walks you through everything: working directory → **engine choice (Claude / Kimi / Codex)** → subscription login → IM platform → auto-start with PM2. **5 minutes to get started.**

> Custom install directory (default `~/metabot`): clone into the directory you want, or `METABOT_HOME=/opt/metabot bash install.sh`. Windows: `.\install.ps1 -Dir C:\opt\metabot`.
>
> One-line install also works: `curl -fsSL https://raw.githubusercontent.com/xiong-zx/metabot/main/install.sh | bash`.

---

## 🔑 Self-Hosted & Auth (Personal Edition)

MetaBot is a **self-hostable personal edition** out of the box: runs locally, single-token auth, **no SSO or corporate login required**.

- **Local-first**: `metabot-core` listens on `http://localhost:9200` by default and generates a local API token on first launch (written to `~/.metabot-core/token`). The CLI and web console both authenticate with it. Data lives under `~/.metabot-core/` by default.
- **No SSO**: no OAuth / OIDC / corporate VPN needed. To expose it to other people or the public internet, put your own reverse proxy (optionally oauth2-proxy) in front — it's never required at the app layer.
- **Distribution endpoints are locked by default**: `/cli/*` and `/install/*` require a token; once you've confirmed your build embeds no secrets, set `METABOT_PUBLIC_DISTRIBUTION=1` to allow anonymous downloads.

---

## Multi-Engine: Claude Code, Kimi Code, and Codex CLI

MetaBot isn't locked to one vendor — all three top AI coding agents ship with native support, and **your subscription works directly**.

| | **Claude Code** (Anthropic) | **Kimi Code** (Moonshot) | **Codex CLI** (OpenAI) |
|---|---|---|---|
| **Subscription login** | ✅ `claude login` OAuth | ✅ `kimi login` | ✅ `codex login` — uses your ChatGPT subscription |
| **API key fallback** | ✅ `ANTHROPIC_API_KEY` or third-party Anthropic-compat endpoints | ✅ Moonshot API key | ✅ `OPENAI_API_KEY` / Codex profile |
| **Context window** | 200k (1M optional on Opus/Sonnet) | 256k (kimi-for-coding) | 400k (gpt-5.x-codex) |
| **Tools** | Read/Write/Edit/Bash/Glob/Grep/WebSearch/MCP | Same (Kimi CLI builtin + `.claude/skills/` auto-discovery) | Codex CLI native toolchain + `.codex/skills/` auto-discovery |
| **Autonomous mode** | `bypassPermissions` | `yoloMode` (equivalent) | Defaults to `--sandbox danger-full-access` to avoid `bwrap` failures on hosts without user namespaces |
| **Subagents** | `.claude/agents/*.md` auto-loaded | Builtin `default` / `okabe` only | Project subagents are not auto-loaded; put role routing in `AGENTS.md` |
| **Workspace doc** | `CLAUDE.md` | `AGENTS.md` (installer creates the symlink) | `AGENTS.md` (Codex convention) |

**One line of config** — each bot picks its engine:
```json
{ "name": "bulma", "engine": "kimi",   "kimi": { "thinking": true } }
{ "name": "goku",  "engine": "claude" }
{ "name": "vegeta", "engine": "codex", "codex": { "model": "gpt-5.5" } }
```

Codex support uses the local `codex exec --json` CLI and resumes chat sessions with `codex exec resume`. Authenticate once with `codex login` (or configure your Codex API key/profile) before starting MetaBot. MetaBot translates Feishu slash-skill invocations like `/<skill> ...` into Codex's explicit `$<skill> ...` skill syntax (e.g. once `/metaschedule` is installed, Codex receives `$metaschedule ...`).

### Codex Migration: Reuse `.claude` Config

Claude/Kimi and Codex use different discovery paths. MetaBot mirrors bundled skills during install/update and Skill Hub installs:

| Content | Claude / Kimi | Codex |
|---------|---------------|-------|
| Workspace instructions | `CLAUDE.md` | `AGENTS.md` |
| Skills | `.claude/skills/<name>/SKILL.md` | `.codex/skills/<name>/SKILL.md` |
| Subagents | `.claude/agents/*.md` | Not auto-loaded; migrate roles/routes into `AGENTS.md` |

For an existing project, ask Codex to migrate it:

```text
/model codex
Use the current project's .claude config to create Codex-compatible .codex/skills and AGENTS.md:
- mirror .claude/skills/* into .codex/skills/*
- generate or update AGENTS.md from CLAUDE.md
- if .claude/agents/*.md exists, merge those subagent roles, routing tables, and workflows into AGENTS.md
```

If the host disables unprivileged user namespaces, Codex CLI's `workspace-write` sandbox can fail before commands run with `bwrap: No permissions to create a new namespace`. MetaBot defaults Codex to `danger-full-access` to avoid that failure; set `CODEX_SANDBOX` or `codex.sandbox` explicitly if you want stricter isolation.

Run your frontend bot on Claude and your backend bot on Kimi? Totally fine. The Agent Bus lets them delegate to each other — the calling bot doesn't need to know which engine is on the other side.

---

## What You Can Build

- **Code from your phone** — message Claude Code / Kimi Code / Codex CLI from Feishu on the subway, it fixes bugs, opens PRs, runs tests
- **Multi-agent teams** — frontend bot, backend bot, infra bot, each in their own workspace (even their own engine), delegating via Agent Bus
- **Self-growing knowledge** — agents save what they learn to MetaMemory, the organization gets smarter daily
- **Automated pipelines** — "Search AI news every morning at 9am, summarize top 5, save to archive" — one sentence
- **Voice assistant (Jarvis mode)** — "Hey Siri, Jarvis" from AirPods, hands-free voice control of any agent
- **Self-growing organization** — a manager bot creates new agents on demand, assigns tasks, schedules follow-ups

## Why MetaBot

| | MetaBot | Claude / Kimi / Codex CLI (terminal) | Dify / Coze |
|---|---|---|---|
| **Mobile access** | Feishu/TG/WeChat anywhere | Terminal only | Yes, but can't run code |
| **Engine choice** | Claude ✕ Kimi ✕ Codex, three engines | One at a time | None, API calls only |
| **Subscription login** | All three native subscriptions work directly | One at a time | Subscriptions not supported |
| **Code capabilities** | Full Agent SDK (Read/Write/Edit/Bash/MCP) | Full | None |
| **Multi-agent** | Agent Bus + task delegation + runtime creation | Single session | Yes, but closed ecosystem |
| **Shared memory** | MetaMemory with FTS + auto-sync to Wiki | None | None |
| **Scheduling** | CC-native `CronCreate` / `/loop` work out of the box; opt-in `/metaschedule` for cross-restart persistence | Native `CronCreate` / `/loop` only | Yes |
| **Autonomous** | bypassPermissions / yoloMode, fully automated | Requires human approval | Limited to workflows |
| **Open source** | MIT, fully controllable | CLI is open source | Closed-source SaaS |

## Multi-Platform Access

![MetaBot Architecture](resources/metabot.png)

```
Feishu/TG/WeChat → IM Bridge → Engine Router ──┬─→ Claude Code Agent SDK
                                                ├─→ Kimi Agent SDK (@moonshot-ai/kimi-agent-sdk)
                                                └─→ Codex CLI (codex exec --json subprocess)
                                    ↕
                         MetaMemory (shared knowledge)
                         Scheduling (CC-native CronCreate / /loop; opt-in /metaschedule for persistence)
                         Agent Bus (cross-bot comms, engine-agnostic)
                         Agent Factory (opt-in /metaskill)
```

The engine layer is abstracted — Kimi's event stream and Codex's JSONL stream are both translated into Claude-shaped `SDKMessage` objects, so streaming cards, tool-call tracking, MetaMemory/Scheduler/Agent Bus behave identically across all three engines.

## Monorepo Layout

As of 2026-05-19, MetaBot absorbed `metabot-core` into a single npm-workspaces monorepo. The bridge runtime stays at the repo root; the central-service half lives under `packages/`:

```
metabot/                       # repo root — bridge runtime (bot hosts run this under PM2)
├── src/                       # bridge engine, stream processing, Feishu/Telegram/WeChat bridges
├── bin/                       # CLI (metabot single entrypoint / doubao-tts)
├── web/                       # bridge's own browser SPA
├── packages/                  # absorbed metabot-core
│   ├── server/                # central HTTP backend (ECS deploy unit)
│   ├── cli/                   # `metabot <subcommand>` feature CLI
│   ├── web-ui/                # central SPA (Vite, served from server/static/)
│   ├── cli-core/              # shared HTTP client building blocks
│   ├── metamemory/            # thin client for /api/memory/*
│   ├── skill-hub/             # thin client for /api/skills/*
│   └── skills/                # default skill bundle source (metabot SKILL.md)
└── docs/                      # all docs
```

The two halves communicate **only over HTTP `/api/*`** — cross-package imports are blocked by ESLint `no-restricted-imports` plus a tight `packages/server/package.json` exports lock. A bot-host `install.sh` installs only the bridge + CLI/CLI-Core dependency closure — server-only deps (fastify / react / vite / server-side better-sqlite3) are **not** pulled. Central-server deployment still uses `cd packages/server && bash deploy/install.sh` (the script uses `$PKG_DIR` and is unaffected by the source-path move).

| Client | Use Case | Key Features |
|--------|----------|-------------|
| **Feishu/Lark** | Work, team collaboration | Streaming interactive cards, @mention routing, Wiki auto-sync |
| **Telegram** | Personal / international | 30-second setup, long polling (no public IP), group + private chat |
| **Web UI** | Browser, voice conversations | Phone call mode (VAD), RTC calls, MetaMemory browser, team dashboard |

## Web UI

| Pillar | Component | What it does |
|--------|-----------|-------------|
| **Supervised** | IM Bridge | Real-time streaming cards show every tool call. Humans see everything agents do |
| **Self-Improving** | MetaMemory | Shared knowledge store. Agents write what they learn, other agents retrieve it |
| **Agent Organization** | Agent Bus + CC-native scheduling (opt-in MetaSkill / MetaSchedule) | Agents delegate tasks and spin up new bots on demand; CC's built-in `CronCreate` / `/loop` cover scheduling, and opt-in `/metaschedule` adds cross-restart persistence |

Full-featured browser-based chat interface. Access at `https://your-server/web/` after starting MetaBot.

![MetaBot Web UI](resources/web-ui.png)

- **Real-time streaming** -- WebSocket, Markdown rendering, tool call display
- **Phone call mode** -- Tap phone icon for fullscreen hands-free voice conversation with VAD
- **RTC calls** -- Two-way voice/video calls via VolcEngine RTC
- **Group chat** -- Multiple agents in one conversation, @mention routing
- **MetaMemory browser** -- Search and browse shared knowledge base
- **Team dashboard** -- Agent organization overview
- **File support** -- Upload/download with inline preview
- **Dark/light themes** -- System-aware with manual toggle

**Stack**: React 19 + Vite + Zustand + react-markdown

> Voice features require HTTPS. We recommend Caddy as a reverse proxy. See [Web UI docs](docs/features/web-ui.md).

## Core Components

| Component | Description |
|-----------|-------------|
| **Triple Engine Kernel** | Each bot independently chooses Claude Code / Kimi Code / Codex CLI — full tool stack (Read/Write/Edit/Bash/Glob/Grep/WebSearch/MCP) in autonomous mode |
| **Persistent Sessions & Goal Loops** | One Claude process per chat — `/goal` keeps the agent auto-driving across turns until a condition is met; teammates and background tasks survive between turns |
| **Agent Teams** | A lead agent spawns specialist teammates in parallel, routes tasks between them, and aggregates results — all in one Feishu chat |
| **CC-Native Scheduling** | Use Claude Code's built-in `CronCreate` and `/loop` directly — zero MetaBot setup, runs in-session |
| **MetaMemory** | Shared knowledge store served by metabot-core (self-hosted locally, default `http://localhost:9200`) with full-text search; MetaBot reads/writes via `/api/memory/*` and can sync to Feishu Wiki |
| **IM Bridge** | Chat with any agent from Feishu, Telegram, or WeChat (including mobile). Streaming cards + tool call tracking |
| **Agent Bus** | Agents talk to each other via `metabot talk`. Create/remove bots at runtime |
| **MetaSchedule (opt-in)** | Persistent server-side scheduler — cron + one-shot, survives restarts, exposes HTTP API + `metabot schedule` CLI. Not installed by default; enable with `cp src/skills/metaschedule/SKILL.md ~/.claude/skills/metaschedule/` |
| **MetaSkill (opt-in)** | Agent factory. `/metaskill` generates portable agent teams. Not installed by default; enable with `cp -r src/skills/metaskill ~/.claude/skills/` |
| **Feishu Lark CLI** | 200+ commands covering docs, messaging, calendar, tasks, and 8 more domains. 19 AI Agent Skills |
| **Skill Hub** | Centralized skill sharing registry. `metabot skills` to publish, discover, and install skills with FTS5 search (provided by metabot-core) |
| **Peers** | Cross-instance bot discovery and task routing. `metabot talk alice/backend-bot` routes automatically |
| **Voice Assistant** | Jarvis mode -- "Hey Siri, Jarvis" from AirPods for hands-free agent control |

## Quick Start

### Telegram (30 seconds)

1. Message [@BotFather](https://t.me/BotFather) → `/newbot` → copy token
2. Add to `bots.json` → done (long polling, no webhooks)

### WeChat (gray testing)

1. iPhone WeChat 8.0.70+ → Settings → Plugins → enable **ClawBot**
2. Run `install.sh`, pick `3) WeChat ClawBot` — scan QR to bind
3. See [WeChat Setup Guide](docs/features/wechat.md)

### Feishu/Lark

1. Create app at [open.feishu.cn](https://open.feishu.cn/) → add Bot capability
2. Enable permissions: `im:message`, `im:message:readonly`, `im:resource`, `im:chat:readonly`
3. Start MetaBot, then enable persistent connection + `im.message.receive_v1` event
4. Publish the app

> No public IP needed. Feishu uses WebSocket, Telegram and WeChat use long polling.

**Web UI**: Visit `http://localhost:9100/web/` after starting MetaBot, enter your API_SECRET.

## Example Prompts

New to MetaBot? Here are real prompts you can send in Feishu/Telegram:

### MetaMemory — Persistent Knowledge

```
Remember the deployment guide we just discussed — save it to MetaMemory
under /projects/deployment.
```

```
Search MetaMemory for our API design conventions.
```

### Scheduling (Claude Code native)

Use CC's built-in `CronCreate` and `/loop` — zero setup, runs inside the session:

```
Schedule a daily task at 9am: search Hacker News and TechCrunch for AI news,
summarize the top 5 stories, and save the summary to MetaMemory.
```

```
/loop poll PR #123's CI status every 5 minutes until it finishes.
```

> Need the schedule to survive MetaBot restarts and be visible to other bots?
> Install the opt-in `/metaschedule` skill
> (`cp src/skills/metaschedule/SKILL.md ~/.claude/skills/metaschedule/`),
> then use `metabot schedule cron` / the HTTP API to submit jobs to MetaBot's
> persistent scheduler.

### Agent Teams — Runtime

```
Act as a lead engineer. Spawn a frontend specialist and a backend specialist
in parallel: the frontend handles the React UI changes, the backend adds the
new /api/reports endpoint, and you review both PRs before merging.
```

### Goal Loops

```
/goal The CI for PR #123 is green and the deploy completes successfully.
Check every 10 minutes and report back when done.
```

### MetaSkill — Agent Factory (opt-in)

`/metaskill` is not installed by default. Enable it first:
`cp -r src/skills/metaskill ~/.claude/skills/`. Then:

```
/metaskill Create an agent team for this React Native project —
I need a frontend specialist, a backend API specialist, and a code reviewer.
```

### Agent-to-Agent

```
Delegate this bug fix to backend-bot: "Fix the null pointer exception
in /api/users/:id endpoint".
```

```
Ask frontend-bot to update the dashboard UI, and at the same time
ask backend-bot to add the new API endpoint. Both should save progress
to MetaMemory.
```

### Combined Workflows

```
Read this Feishu doc [paste URL], extract the product requirements, break
them into tasks, and schedule a daily standup summary at 6pm that tracks
progress against these requirements.
```

```
(First copy src/skills/metaskill into ~/.claude/skills/ to enable /metaskill)
/metaskill Create a "daily-ops" agent that runs every morning at 8am:
checks service health, reviews overnight error logs, and posts a summary.
```

## Feishu Usage Tips

<details>
<summary><strong>DM vs Group Chat</strong></summary>

| Scenario | @mention | Notes |
|----------|----------|-------|
| **Direct message** | Not needed | All messages go to the bot |
| **1-on-1 group** (you + bot, 2 members) | Not needed | Auto-detected as DM-like |
| **Multi-member group** | @Bot required | Only @mentioned messages trigger a response |

> **Tip**: Create a 2-person group with just you and the bot. No @mention needed, plus you get group features like pinning.

</details>

<details>
<summary><strong>Sending Files & Images</strong></summary>

**DM / 2-person group**: Send files or images directly — auto-processed. Multiple files within 2 seconds are batched.

**Multi-member group**: Feishu doesn't allow @mentioning while uploading. Workaround: **upload first, @mention later**

1. Upload files in the group
2. Within 5 minutes, @Bot with your instruction
3. Bot auto-attaches your previously uploaded files

Supported: text, images (Claude multimodal), files (PDF/code/docs), rich text (Post format), batch upload.

</details>

## Configuration

**`bots.json`** — define your bots:

```json
{
  "feishuBots": [{
    "name": "metabot",
    "feishuAppId": "cli_xxx",
    "feishuAppSecret": "...",
    "defaultWorkingDirectory": "/root/workspaces"
  }],
  "telegramBots": [{
    "name": "tg-bot",
    "telegramBotToken": "123456:ABC...",
    "defaultWorkingDirectory": "/root/workspaces"
  }]
}
```

<details>
<summary><strong>All bot config fields</strong></summary>

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `name` | Yes | — | Bot identifier |
| `defaultWorkingDirectory` | Yes | — | Working directory for Claude |
| `feishuAppId` / `feishuAppSecret` | Feishu | — | Feishu app credentials |
| `telegramBotToken` | Telegram | — | Telegram bot token |
| `wechatBotToken` | WeChat (opt) | — | Pre-authenticated iLink token (omit for QR login) |
| `maxTurns` / `maxBudgetUsd` | No | unlimited | Execution limits |
| `model` | No | SDK default | Claude model |
| `apiKey` | No | — | Anthropic API key (leave unset for dynamic auth via cc-switch) |
| `pmPrompt` | No | `false` | Enables the research-PM behavior contract and the 40-minute worker check-in reminder |
| `visible` | No | `true` | Whether this bot is visible to other bots / Agent Bus and reachable via `metabot talk`. Re-asserted from `bots.json` on every bridge bulk-register (not sticky) |
| `memoryPublic` | No | `true` | Default target for `metabot memory create/mkdir` when no `--path` is given: `true` = `/shared/<bot>` (readable by everyone), `false` = `/users/<bot>` (private). Explicit `--path` always wins. Omitting the field preserves the last `metabot memory visibility` CLI toggle (sticky) |

Global fields:

| Field | Default | Description |
|-------|---------|-------------|
| `workers.defaultModel` | `gpt-5.4` | Default model for `worker_dispatch` |
| `workers.maxPerPm` | `8` | Maximum concurrent workers per PM chat |
| `agentTeamExecutionBot` | fallback | Bot used by the Agent Team supervisor to execute teammate runs; set this to `research-pm` or an internal worker so runs do not fall through to `manager` |

`agentTeams[].agents[]` also supports per-member execution overrides:

| Field | Description |
|-------|-------------|
| `engine` / `model` | Engine and model for this member, for example reviewer with `codex` + `gpt-5.5` |
| `reasoningEffort` | Member reasoning effort: `minimal` / `low` / `medium` / `high` / `xhigh` / `max` |
| `approvalPolicy` / `sandbox` | Codex permission boundary, for example reviewer with `approvalPolicy: "never"` + `sandbox: "read-only"` |
| `timeoutMs` / `idleTimeoutMs` | Total timeout and no-output timeout for one member run |
| `allowedTools` | Claude tool allowlist; omit it to use the bot default tool policy |

</details>

<details>
<summary><strong>Environment variables (.env)</strong></summary>

| Variable | Default | Description |
|----------|---------|-------------|
| `API_PORT` | 9100 | HTTP API port |
| `API_SECRET` | — | Bearer token auth (protects API + Web UI). Generate one with `openssl rand -hex 32` |
| `METABOT_CORE_URL` | `http://localhost:9200` | metabot-core service URL (MetaMemory + Skill Hub + Agents + T5T) — self-host locally or point at your own remote host |
| `METABOT_CORE_TOKEN` | reads `~/.metabot-core/token` | Bearer token for metabot-core |
| `WIKI_SYNC_ENABLED` | true | Enable MetaMemory→Wiki sync |
| `WIKI_SPACE_NAME` | MetaMemory | Wiki space name |
| `WIKI_SYNC_STATE_DIR` | `./data` | Directory holding the wiki-sync mapping SQLite |
| `VOLCENGINE_TTS_APPID` | — | Doubao voice (TTS + STT) |
| `VOLCENGINE_TTS_ACCESS_KEY` | — | Doubao voice key |
| `METABOT_URL` | `http://localhost:9100` | MetaBot API URL. Default is local HTTP; for remote access prefer HTTPS or a private-network address |
| `METABOT_PEERS` | — | Peer MetaBot URLs (comma-separated). Prefer HTTPS for internet-reachable peers |
| `LOG_LEVEL` | info | Log level |

</details>

<details>
<summary><strong>Third-party AI providers</strong></summary>

Supports any Anthropic-compatible API:

```bash
ANTHROPIC_BASE_URL=https://api.moonshot.ai/anthropic    # Kimi/Moonshot
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic   # DeepSeek
ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic       # GLM/Zhipu
ANTHROPIC_AUTH_TOKEN=your-key
```

</details>

<details>
<summary><strong>cc-switch compatibility</strong></summary>

Compatible with [cc-switch](https://github.com/farion1231/cc-switch), [cc-switch-cli](https://github.com/SaladDay/cc-switch-cli), [CCS](https://github.com/kaitranntt/ccs). Switching via `cc switch` takes effect **without restarting** MetaBot.

To pin a specific API key, set the `apiKey` field in `bots.json`.

</details>

<details>
<summary><strong>Security</strong></summary>

MetaBot runs Claude Code in `bypassPermissions` mode — no interactive approval:

- Claude has full read/write/execute access to the working directory
- Control access via IM platform settings (app visibility, group membership)
- Use `maxBudgetUsd` to cap cost per request
- `API_SECRET` enables Bearer auth on API server
- MetaMemory is hosted by the central metabot-core service; auth and folder ACLs are managed there

</details>

## Chat Commands

| Command | Description |
|---------|-------------|
| `/reset` | Clear session |
| `/stop` | Abort current task |
| `/status` | Session info (includes current model) |
| `/goal <condition>` | Set a goal the agent keeps pursuing across turns. `/goal clear` to stop |
| `/model` | Show current engine/model; `/model list` — available engines/models; `/model claude`, `/model kimi`, or `/model codex` — switch engine; `/model <name>` — set model; `/model reset` — restore default |
| `/memory list` | Browse knowledge tree |
| `/memory search <query>` | Search knowledge base |
| `/sync` | Sync MetaMemory to Feishu Wiki |
| `/metaskill ...` | Generate agent teams, agents, or skills (opt-in skill — not installed by default) |
| `/help` | Show help |

> **Model switching**: Each session can pick its own model; default is `claude-opus-4-8`. All models default to 200k context; append `[1m]` to the model name to enable the 1M context window (supported by Opus 4.8/4.7/4.6 and Sonnet 4.6), e.g. `/model claude-opus-4-8[1m]`. OAuth/Pro-Max users must use this suffix — the SDK silently drops beta headers under that auth mode. Note: 1M is billed the same as 200k while context stays under 200K, but all tokens jump to 2× once a request crosses 200K — which is why the default stays at 200k.
> **Codex skills**: Slash invocations like `/<skill> ...` are auto-rewritten to Codex's `$<skill> ...` form whenever the active session runs on Codex.

<details>
<summary><strong>API Reference</strong></summary>

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Health check (no auth required) — returns `{ status, uptime }` only |
| `GET` | `/api/status` | Rich status: bots, peers, scheduled/recurring tasks (auth required) |
| `GET` | `/api/bots` | List bots (local + peer) |
| `POST` | `/api/bots` | Create bot at runtime |
| `DELETE` | `/api/bots/:name` | Remove bot |
| `POST` | `/api/talk` | Talk to a bot (auto-routes to peers) |
| `GET` | `/api/peers` | List peers and status |
| `POST` | `/api/schedule` | Schedule task |
| `GET` | `/api/schedule` | List scheduled tasks |
| `PATCH` | `/api/schedule/:id` | Update task |
| `DELETE` | `/api/schedule/:id` | Cancel task |
| `POST` | `/api/sync` | Trigger Wiki sync |
| `GET` | `/api/stats` | Cost & usage stats |
| `GET` | `/api/metrics` | Prometheus metrics |
| `POST` | `/api/tts` | Text-to-speech |
| `GET` | `/api/skills` | List skills (local + peer) |
| `GET` | `/api/skills/search?q=` | Full-text search skills |
| `GET` | `/api/skills/:name` | Get skill details |
| `POST` | `/api/skills` | Publish a skill |
| `POST` | `/api/skills/:name/install` | Install skill to a bot |
| `DELETE` | `/api/skills/:name` | Remove a skill |

</details>

<details>
<summary><strong>CLI Tools</strong></summary>

The installer places `metabot` in `~/.local/bin/` — available immediately. `metabot` is the **single CLI binary** with three command categories: (1) bridge process control (`update` / `start` / `stop` / `restart` / `logs` / `status`); (2) bridge daemon API (`bots` / `talk` / `schedule` / `peers` / `stats` / `voice` / `health`, which curl the local bridge at `localhost:9100`); (3) everything else (`t5t` / `agents` / `memory` / `skills`) forwards to the metabot-core feature CLI shipped in this monorepo at `packages/cli/bin/metabot`. The legacy `mb`/`mm`/`mh` CLIs and the standalone `metamemory` / `skill-hub` skill bundles have all been removed; install/update actively cleans up any leftover binaries in `~/.local/bin/`.

```bash
# 1. MetaBot process management (handled in-script by bin/metabot)
metabot update                      # internal package refresh, rebuild, restart
metabot update --git                # developer-only: git pull + rebuild + restart
metabot start / stop / restart      # PM2 management
metabot logs                        # view live logs
metabot status                      # PM2 process status

# 2. Bridge daemon API (curls the local bridge at localhost:9100)
metabot bots                        # list all bots
metabot talk <bot> <chatId> <prompt> # talk to a bot
metabot stats                       # cost & usage stats
metabot voice tts "Hello world" --play  # text-to-speech

# 3. Feature subcommands (forwarded to packages/cli/bin/metabot)
metabot t5t board                   # team standup board
metabot agents list                 # peer-bot directory
metabot memory search "deployment guide"   # shared-memory full-text search
metabot memory visibility           # show whether this bot writes to /shared/<bot> or /users/<bot> by default
metabot memory visibility private   # switch to private (default writes land in /users/<bot>, owner-only)
metabot skills list                 # skill registry (central Skill Hub)
# Override CLI path: export METABOT_CORE_CLI=/path/to/packages/cli/bin/metabot

# Scheduling — prefer Claude Code's native CronCreate / /loop directly in chat.
# The persistent server-side scheduler (`metabot schedule list / cron / cancel /
# pause / resume`) is exposed by the opt-in /metaschedule skill. Enable with:
#   cp src/skills/metaschedule/SKILL.md ~/.claude/skills/metaschedule/

# Feishu Lark CLI (Feishu bots only)
lark-cli docs +fetch --doc <feishu-url>
lark-cli im +messages-send --chat-id oc_xxx --text "Hi"
lark-cli calendar +agenda --as user
```

CLI supports connecting to a remote MetaBot server — configure `METABOT_URL` in `~/.metabot/.env`. MetaMemory / Skill Hub / Agents / T5T all live in central metabot-core inside this monorepo at `packages/server/`; configure `METABOT_CORE_URL` + `METABOT_CORE_TOKEN`, get a token at `<METABOT_CORE_URL>/cli`.

</details>

<details>
<summary><strong>Manual install</strong></summary>

```bash
git clone https://github.com/xiong-zx/metabot.git
cd metabot && npm install
cp bots.example.json bots.json   # edit with your bot configs
cp .env.example .env              # edit global settings
npm run dev
```

Prerequisites: Node.js 20+, native build tools (Linux: `python3 make g++`; macOS: Xcode Command Line Tools), and [Claude Code CLI](https://github.com/anthropics/claude-code) installed and authenticated. `install.sh` checks and prompts for these automatically. If a manual `npm install` cannot download Node headers because of a proxy/certificate chain and `/usr/include/node` exists, run `export npm_config_nodedir=/usr` first.

</details>

## Development

```bash
npm run dev          # Hot-reload dev server (tsx)
npm test             # Run tests (vitest)
npm run lint         # ESLint check
npm run build        # TypeScript compile
```

## Roadmap

- [ ] Plugin marketplace (one-click MCP Server install)
- [ ] More IM platforms (Slack, Discord, DingTalk)

## About

MetaBot is built by [XVI Robotics](https://xvirobotics.com) (humanoid robot brains). We use MetaBot internally to run our company as an **agent-native organization** — a small team of humans supervising self-improving AI agents.

We open-sourced it because we believe this is how companies will work in the future.

## License

[MIT](LICENSE)
