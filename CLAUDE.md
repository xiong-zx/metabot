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

## Git 分支工作流（提交前必读）

本仓库按工作流分支，**提交前先选对分支**，别把不同工作流混进同一个 commit：

| 分支 | 用途 | 谁往这提交 |
|---|---|---|
| `main` | 稳定/发布分支，只经 PR 合入，历史干净 | 不直接提交 |
| `feat/agent-team` | agent team / template 相关开发 | team / template 任务 |
| `feat/memory-core` | memory core + auto research（两者**不拆**，同一条），当前 stacked 在 `feat/agent-team` 之上 | memory / auto-research 任务 |
| `fix/<描述>` | 日常小 bug，短命分支，修完尽快合 | 单个 bug 修复 |
| `dev` | 集成 + 部署分支：多 feature 合一起跑 live 服务；不对外 PR、不追求干净历史 | 只做集成/联调，别在这开发新特性 |

- 一个 commit 只做一件事；memory 的活别碰 agent-team 的文件，反之亦然。
- **禁止**直接往 `main` 提交；**禁止** rebase / force-push 任何共享分支（`dev`、已推送的 `feat/*`）。
- 要跑 live 验证 → 把 feature 分支合进 `dev`；要评审 / 进 `main` → 从 feature 分支开 PR。
- feature 分支从 `main` 拉；若新工作依赖别的 feature（如 memory-core 依赖 agent-team），就 stack 在那条 feature 上，别硬拆成独立分支。

## MetaBot 重启安全

改完 `src/` 需要让 bridge 生效时，**一律走 `metabot restart`，不要自己拼 `pm2` 命令**：

```bash
metabot restart --wait --json --resume \
  --reason "<为什么重启>" --source pm --bot <botName> --chat <chatId>
```

- 同一 runtime 的普通重启只用 `metabot restart`（底层就是单次 `pm2 restart metabot --update-env`）。裸 `pm2 restart` 能跑通，但会跳过下面四层保护，属于**看起来成功、实则失去保护**的操作：
  - `_ensure_runtime_deps`：重启前校验 tsx 可解析，缺失则拒绝重启，避免撞进 10 次崩溃循环直到 PM2 放弃（bridge 用 `node --import tsx` 直接跑 `src/index.ts`，tsx 一旦被 prod install 剪掉就起不来）
  - `_write_restart_breadcrumb`：落 `last-restart.json`，bridge 启动时注入提示。**没有它，被 `--resume` 恢复的 agent 会在历史里重新读到"请重启"，然后再重启一次，形成循环**
  - `_claim_restart_request`：按 requestId 原子 claim，重复请求返回 duplicate 而不是真重启
  - `--wait`：等健康检查 + 终态落 `restart-requests.json` 审计台账，而不是靠 `sleep` 猜
- MetaBot 自身启动的 Bot / Agent / Worker / Codex / Claude / shell 子进程，禁止 `pm2 delete metabot` 或 `pm2 stop metabot` 后再 `pm2 start`——第一步会杀掉执行第二步的进程树。也不要把 `pm2 save` 放进旧进程的重启 shell，由新进程健康检查通过后再保存。
- 切换 cwd / script / worktree 必须从 MetaBot 进程树**之外**的 SSH、supervisor 或独立控制器执行 `metabot deploy-runtime --runtime <dir>`；该命令在进程树内部调用时 fail closed。
- 恢复 turn 里看到已有 restart requestId / breadcrumb，只做健康检查、验收和剩余工作；同一 requestId 不得再触发一次真实重启。

> 重启会杀掉 bridge 的所有子进程，包括发起重启的那个 Claude 会话本身。会话随后由 `--resume <sessionId>` 拉起、从 JSONL 恢复历史，所以**对话看起来毫无断裂，但进程已经全换了**——不要据此认为"重启没发生"。

<!-- METABOT-WORKER -->
# Worker Agent 规范

你是由 PM agent 派发的 Worker。专注完成被分配的任务。

## 规则
- GPU 训练：先 `nvidia-smi` 找空闲 GPU，用 `CUDA_VISIBLE_DEVICES` 指定
- 特征构建：NumPy/Pandas 向量化，禁止 Python for 循环
- 安装依赖前先检查：`python3 -c "import xxx" 2>/dev/null || pip install xxx -q`
- 训练日志写入 workdir/train.log
- 所有实验必须用 WandB 记录：`wandb.init(project="<项目名>", entity=os.environ["WANDB_ENTITY"])`（entity 以环境变量 `WANDB_ENTITY` 或 PM 指令中给出的为准）
- Git commit 所有代码改动；**提交前按上方「Git 分支工作流」选对分支**，不同工作流不要混进同一个 commit
- 下载大数据集/模型用学术加速：`bash -c 'source /etc/network_turbo && <命令>'`（仅在该脚本存在的服务器上）
- 获得稳定结论/踩坑经验时，更新本 workdir 的 `AGENTS.md`（项目级记忆：环境配置、数据路径、坑、约定，供后续 worker 与 PM 复用）；不要删除其中已有内容

## 结果输出
完成后将结果写入 workdir/results.json，格式根据任务类型自定：
```json
{"task": "简述任务", "metrics": {"<指标名>": <数值>, ...}, "notes": "关键发现"}
```

## 进度上报
定期更新 workdir/worker-progress.json:
```json
{"status": "running", "step": "当前步骤描述", "metrics": {}, "timestamp": "ISO8601"}
```

## 返回格式（必须）
完成后最后一行输出：
```
RESULT: task=[简述] metrics={<指标名>=<数值>, ...} notes=[简短说明]
```
