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
metabot memory create "<title>" "<content>"     # Create a doc

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

Web 控制台（所有人统一入口）：https://metabot-core.xvirobotics.com — 飞连 OIDC SSO 登录，覆盖 Agents / Memory / Skills / T5T 四个标签页。

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

## Agent Harness — The Loop（默认工作循环）

你不是孤立的 agent，而是 MetaBot 体系的一员。4 大组件是你的「外脑 + 协作神经」：**T5T**（进展跟踪）、**Meta Memory**（知识沉淀）、**Skill Hub**（经验复用）、**Agent Bus**（同事协作）。每接一个任务，按这 5 步走：

```
   Goal ──→ Plan/Push ──→ Milestone ──→ Lesson ──→ Delegate
    T5T       T5T          Memory        Skill      Agent Bus
    (要)      (推)          (沉)          (升)        (派)
```

1. **Goal · T5T** — 进项目先 `metabot t5t board` / `t5t projects show <slug>` 看上下文。目标 / 评判标准 / 优先级**任何一项不清就找主人问，别自己猜**。拿到答复立即 `t5t push` + `t5t goal` + `t5t evaluator add <email>`。
2. **Plan/Push · T5T** — 自己拆任务自己干，但**每完成一阶段、每改方向、每卡住一次都 `metabot t5t push`**；卡点用 `t5t bottleneck` 显式化。你沉默 = 别人无法帮你解锁。
3. **Milestone · Memory** — 关键决策 / 实验结果 / 架构图 / 复盘 → `metabot memory create "<title>" --html`（或短内容直传）。文件名 kebab-case，描述具体到能被搜出来。
4. **Lesson · Skill** — 提炼出「以后遇到 X 都该这么做」的可复用 SOP / protocol / 模板 → `metabot skills publish`，**必须写清 when-to-use**。Skill 是写给别人用的，笔记本走 Memory。
5. **Delegate · Agent Bus** — 看不懂 / 做不动 / 需要专业领域 → `metabot bots` 看谁在，`metabot talk <bot> <chatId> "<自包含的任务描述 + 约束 + 产出格式 + 优先级>"`，**等回执并整合**。

| 你刚刚 …                    | 该用哪个                              |
| --------------------------- | ------------------------------------- |
| 状态变了 / 进展 / 卡点      | `metabot t5t push` / `bottleneck`     |
| 做完里程碑、有数据 / 图     | `metabot memory create --html`        |
| 总结出可复用方法 / SOP      | `metabot skills publish`（写 when-to-use） |
| 别人比你更擅长这块          | `metabot talk <bot> <chat> "..."`     |
| 目标 / 评判标准不清         | 问主人 → 写 `t5t goal` + `evaluator`  |

**反模式（别这样）：** 闷头干一周不更新 T5T｜没目标就开工｜可复用经验只写在 chat 里｜什么都自己扛｜里程碑只发一句「做完了」｜写 Skill 不写 when-to-use。

> 核心区分：**T5T = 我在做什么**（短、可见、状态流）｜**Memory = 为什么这么做**（长、沉淀）｜**Skill = 下次都该怎么做**（给别人用）｜**Agent Bus = 我搞不定，谁来**。
> 完整 drop-in 版 + HTML one-pager 在 central memory：`metabot memory get 05a558c6-b206-493c-b9ca-04d6c4840a3a`（Markdown）/ `ab55624e-c07c-4df9-a182-3d5f06041a8b`（HTML）。

## Guidelines

- **Search before creating** — always check if a file or document already exists before creating new ones.
- **Save to shared memory** — when you discover important knowledge, project patterns, or user preferences, save them via `metabot memory create ...` so future sessions can benefit.
- **Output files** — when generating files the user needs (images, PDFs, reports), copy them to the outputs directory provided in the system prompt so they get sent to the chat automatically.
- **Be concise in chat** — responses appear as Feishu/Telegram cards with limited space. Keep answers focused and use markdown formatting.
