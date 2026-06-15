# MetaBot Workspace

This workspace is managed by **MetaBot** — an AI assistant accessible via Feishu/Telegram that runs the Claude Code, Kimi, or Codex agent engine with full tool access. The bot's engine is configured per-bot in `bots.json` (`engine: "claude" | "kimi" | "codex"`).

## Available Skills

### /metabot — Unified CLI (memory, skills, agents, t5t, bridge)

`metabot` is the **single** CLI for everything: shared memory, skill hub, peer-bot agent bus, t5t status portal, and bridge process control. Legacy `mb` / `mm` / `mh` / `mbcore` shortcuts are all gone — install and `metabot update` actively clean any stragglers from `~/.local/bin/`. Use `metabot <subcommand>` everywhere.

```bash
# Shared memory (central knowledge store)
metabot memory search <query>                   # Full-text search
metabot memory get <id|path>                    # Read a doc
metabot memory list [folder_id]                 # Browse the tree
metabot memory create "<title>" "<content>" --share --tags team,sop
metabot memory share <doc_id> on                # Make an existing doc visible

# Skill hub
metabot skills list                             # List published skills
metabot skills install <name>                   # Install into .claude/skills/<name>

# Agent bus — peer-bot directory + cross-bot talk
metabot bots                                    # List all bots (local + peer)
metabot peers                                   # List peers and their status
metabot talk <botName> <chatId> <prompt>        # Delegate a task to a bot

# Bridge process control + diagnostics
metabot update | restart | logs | status        # Bridge lifecycle
metabot health                                  # Health check
```

For the full API (create bots, sendCards, Skill Hub publish, t5t push/feedback/retract, etc.), use the `/metabot` skill.

Web 控制台：metabot-core 服务自带（默认 `http://localhost:9200`，或你自托管的地址）— 用本地 API token 访问，覆盖 Agents / Memory / Skills / T5T 四个标签页。

### Scheduling (Claude Code native)

Prefer Claude Code's built-in scheduling tools for ad-hoc, session-scoped tasks — no MetaBot server hop, runs in-process, stops when the session ends:

- **`CronCreate`** — fire a prompt on a cron schedule (recurring or one-shot). Pass `durable: true` to persist across restarts. Example use cases: "remind me at 3pm", "every weekday at 9am summarize my inbox".
- **`/loop [interval] <prompt>`** — turn any task into a self-paced loop. Examples: `/loop 5m check the deploy`, `/loop check every PR` (dynamic mode — you pace yourself).

For **persistent server-side scheduling** that outlives the Claude session, is visible to other bots, and lives in MetaBot's PM2 process, install the optional `/metaschedule` skill (not installed by default). Copy `<METABOT_HOME>/src/skills/metaschedule/SKILL.md` into `~/.claude/skills/metaschedule/` (or the bot's `.claude/skills/`).

### /metaskill — AI Agent Team Generator (optional)

Not installed by default. Generates portable agent teams, individual agents, or custom skills (`CLAUDE.md` / `AGENTS.md` + SKILL files). Enable it by copying `<METABOT_HOME>/src/skills/metaskill/` into `~/.claude/skills/` (or the bot's `.claude/skills/`). Once installed:

```
/metaskill ios app          → generates a portable agent team
/metaskill a security agent → creates a single agent
/metaskill a deploy skill   → creates a custom skill
```

### Feishu / Lark CLI (Feishu bots only)

`lark-cli` is the official Feishu CLI tool with 200+ commands covering 11 business domains. It is pre-installed and configured for Feishu bots.

```bash
lark-cli docs +create --title "..." --markdown "..."    # Create document
lark-cli docs +fetch --doc "<url>"                       # Read document
lark-cli im +messages-send --chat-id oc_xxx --text "Hi"  # Send message
lark-cli calendar +agenda --as user                      # View calendar
lark-cli base records list ...                           # Query bitable
```

19 AI Agent Skills are installed (lark-doc, lark-im, lark-calendar, lark-sheets, lark-base, lark-task, lark-drive, lark-mail, lark-wiki, etc.) providing structured guidance for each domain. Claude/Kimi discover these under `.claude/skills`; Codex discovers the mirrored copies under `.codex/skills`.

## Guidelines

- **Search before creating** — always check if a file or document already exists before creating new ones.
- **Save to shared memory** — when you discover important knowledge, project patterns, or user preferences, save them via `metabot memory create ... --share --tags ...` so future sessions can benefit. Meta Memory read visibility is document-level: use `--share` on create/update, or `metabot memory share <doc_id> on` for an existing doc. Tags are for discovery and should describe audience/topic such as `team`, `sop`, `metabot`, or `public`.
- **Output files** — when generating files the user needs (images, PDFs, reports), copy them to the outputs directory provided in the system prompt so they get sent to the chat automatically.
- **Be concise in chat** — responses appear as Feishu/Telegram cards with limited space. Keep answers focused and use markdown formatting.
