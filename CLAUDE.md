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

### Scheduling

> **引擎差异**：本节前半部分（`CronCreate` / `/loop`）是 **Claude engine 专有**的 Claude Code 内建工具。Codex / Kimi engine 没有这些工具，直接用后半部分的 `/metaschedule`，或 `remind_me` MCP 工具。

Claude engine 优先用 Claude Code 内建调度处理临时的、会话内的任务 — 不经 MetaBot 服务器中转，进程内运行，会话结束即停：

- **`CronCreate`** — fire a prompt on a cron schedule (recurring or one-shot). Pass `durable: true` to persist across restarts. Example use cases: "remind me at 3pm", "every weekday at 9am summarize my inbox".
- **`/loop [interval] <prompt>`** — turn any task into a self-paced loop. Examples: `/loop 5m check the deploy`, `/loop check every PR` (dynamic mode — you pace yourself).

For **persistent server-side scheduling** that outlives the session, is visible to other bots, and lives in MetaBot's PM2 process, install the optional `/metaschedule` skill (not installed by default). Copy `<METABOT_HOME>/src/skills/metaschedule/SKILL.md` into `~/.claude/skills/metaschedule/`（Codex 用 `.codex/skills/`，或该 bot 的 skills 目录）。

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

| 你刚刚 …                | 该用哪个                                   |
| ----------------------- | ------------------------------------------ |
| 状态变了 / 进展 / 卡点  | `metabot t5t push` / `bottleneck`          |
| 做完里程碑、有数据 / 图 | `metabot memory create --html`             |
| 总结出可复用方法 / SOP  | `metabot skills publish`（写 when-to-use） |
| 别人比你更擅长这块      | `metabot talk <bot> <chat> "..."`          |
| 目标 / 评判标准不清     | 问主人 → 写 `t5t goal` + `evaluator`       |

**反模式（别这样）：** 闷头干一周不更新 T5T｜没目标就开工｜可复用经验只写在 chat 里｜什么都自己扛｜里程碑只发一句「做完了」｜写 Skill 不写 when-to-use。

> 核心区分：**T5T = 我在做什么**（短、可见、状态流）｜**Memory = 为什么这么做**（长、沉淀）｜**Skill = 下次都该怎么做**（给别人用）｜**Agent Bus = 我搞不定，谁来**。
> 完整 drop-in 版 + HTML one-pager 在 central memory：`metabot memory get 05a558c6-b206-493c-b9ca-04d6c4840a3a`（Markdown）/ `ab55624e-c07c-4df9-a182-3d5f06041a8b`（HTML）。

## Guidelines

- **Search before creating** — always check if a file or document already exists before creating new ones.
- **Save to shared memory** — when you discover important knowledge, project patterns, or user preferences, save them via `metabot memory create ...` so future sessions can benefit.
- **Output files** — when generating files the user needs (images, PDFs, reports), copy them to the outputs directory provided in the system prompt so they get sent to the chat automatically.
- **Be concise in chat** — responses appear as Feishu/Telegram cards with limited space. Keep answers focused and use markdown formatting.

## Git 分支工作流（提交前必读）

核心规则一句话：**`main` 是主干，`dev` 是一次性联调场，`dev` 永远不并入 `main`。**

这一条同时保证了「每个 PR 天生干净」（PR 从 `feat/*` / `fix/*` 开，不从 `dev` 开）和「`dev` 不必每个位置都可发布」（它从不发布）。这是 `linux-next` 的模式：集成一切供测试，从不并入 mainline，随时可重建。

| 分支         | 角色                                             | 从哪切出 | 到哪去                | 可否重写历史             |
| ------------ | ------------------------------------------------ | -------- | --------------------- | ------------------------ |
| `main`       | 主干，唯一可发布                                 | —        | 部署 / 发布           | **禁止**                 |
| `feat/<描述>` | 一个功能，长短命均可                             | `main`   | PR → `main`           | 未推送前可 rebase        |
| `fix/<描述>`  | 一个修复，短命，修完尽快合                       | `main`   | PR → `main`           | 未推送前可 rebase        |
| `dev`        | 一次性联调场 = 服务当前运行的内容                | `main`   | **哪也不去**          | **允许 force-push**      |

- **禁止**直接往 `main` 提交；**禁止** rebase / force-push `main` 与任何已推送的 `feat/*` / `fix/*`。
- `dev` 是上一条的**明确例外**：没有任何东西从 `dev` 流出，重写它伤不到任何人，因此 `git reset --hard main` + force-push 是 `dev` 的正常维护手段，用来清掉积累的 merge 噪声。
- 一个 commit 只做一件事；不同功能的活不要混进同一个 commit。
- **合进 `dev` 是 feature 的_测试_路径，不是_发布_路径。** feature 进 `main` 只走 PR，与 `dev` 无关。

### feature 之间如何取用彼此的成果

- 对方**已合入 `main`** → 在自己分支上 `git merge main`。这是常规的跟进主干。
- 对方**尚未完成** → **stack**：直接从对方分支切出（`git checkout -b feat/A feat/B`），或在自己分支上 `git merge feat/B`。此时 A 的 PR 会包含 B 的 commit，所以**必须等 B 先合入 `main`，A 的 PR 才会变干净**；在 GitHub 上把 A 的 PR base 设成 `feat/B`，B 合并后 base 会自动切到 `main`。
- 不要为了"独立"硬拆有真实依赖的工作。

### 长命 feature 如何跟上修复

在 feature 分支上 `git merge main`（**不是 `git merge dev`**）。修复经 `fix/*` → PR → `main` 后，所有 feature 从 `main` 取用。合 `dev` 会把别人未完成的功能拖进你的 PR。

### 发布节奏

feature 初步可用即可 PR 进 `main` 发布给用户试用，反馈回来再从 `main` 切 `fix/<描述>` 继续改。**「可发布」指「不崩、可用」，不是「功能完美」**；小步合入 + 后续小 PR，远比长命分支健康。

### live 验证与重启位置（固定，不要漂移）

**服务永远只从本机的 runtime checkout `$METABOT_HOME` 运行，该 checkout 永远停在 `dev`。绝不在 `feat/*` 的 worktree 里重启服务。**

> `$METABOT_HOME` 是**每台机器各自的** metabot 运行目录，**不是**跨机器通用的固定路径——本仓库在不同服务器上的落点不同。解析顺序与 `bin/metabot` 的实现一致：环境变量 `METABOT_HOME` → `bin/metabot` 脚本所在目录的父目录（跟随符号链接）→ `$HOME/metabot`。要确认本机取值，跑 `metabot doctor --json` 读 `metabotHome` 字段。**下文所有 `$METABOT_HOME` 一律按本机实际取值理解，不要照抄其他机器的路径。**
>
> 本节只约束**跑 metabot 服务的机器**。仅把本仓库作为参考/开发 checkout、不跑服务的机器不受「停在 `dev`」约束，停在 `main` 或任何分支都可以。
>
> 该变量由 pm2 注入（`ecosystem.config.cjs` 的 `env` 中 `METABOT_HOME: __dirname`），bridge 及其 spawn 出的 bot 会话都继承它，因此在 bot 会话里通常已就绪。但**普通 SSH shell 里它可能是空的**（`.env`、`~/.bashrc`、`/etc/environment` 都不设置它），而 `cd ""` 会**静默成功并留在当前目录**——那正是本节要防的漂移。所以下面一律写成 `cd "${METABOT_HOME:?...}"`：变量为空时立即报错中止，绝不在错误的目录上继续 merge 和重启。

要 live 测某个 feature：

```bash
cd "${METABOT_HOME:?未设置：先 export METABOT_HOME=<本机 metabot 运行目录>}"   # 唯一 runtime，永远是这里
git merge feat/A            # 把要测的合进来
metabot restart --wait --json --resume --reason "live test feat/A" --source pm --bot <botName> --chat <chatId>
```

`dev` 乱了或要换一组测：

```bash
cd "${METABOT_HOME:?未设置：先 export METABOT_HOME=<本机 metabot 运行目录>}"
git reset --hard main       # dev 是一次性的，随时重建
git merge feat/B
metabot restart --wait --json --resume --reason "live test feat/B" --source pm --bot <botName> --chat <chatId>
```

这样 `metabot restart` 永远在同一目录、同一分支上执行。`metabot deploy-runtime` 只在真要更换 runtime checkout 时用，日常联调用不到——见「MetaBot 重启安全」。

### merge 后的 semantic loss sweep

- 非平凡 merge 后不能只看 conflict 文件；必须分别对两个 parents 做 semantic loss sweep，至少比对 test-name inventory 和 exported/declaration symbol inventory。可先用 `git diff --name-only <parent> HEAD -- tests src packages | rg '^(tests|src|packages)/.*\.ts$'` 取文件，再用 `rg -n "^\\s*(it|test)\\("` 与 `rg -n "^\\s*export\\s+(function|class|const|type|interface|enum)|^\\s*(function|class|const|type|interface|enum)\\s+"` 生成 parent/merge 清单后 `comm -23`；任何丢失都要补回或在 commit 说明中解释，因格式换行产生的符号假阳性也必须逐项核验并记录。

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

## 项目环境备注

按时间累积的本机踩坑记录。新增往下追加，**不要删除已有条目**。

- 若 `npm ci` 在 `node-pty` / `node-gyp` 阶段下载 `node-v*-headers.tar.gz` 因 `SELF_SIGNED_CERT_IN_CHAIN` 失败，优先使用本机 Node 头文件绕过下载：`npm_config_nodedir=/usr npm_config_strict_ssl=false npm ci`。本环境已验证 `/usr/include/node` 可用。
- 2026-07-05 启动 bridge 服务时发现全局 `pm2` 缺失；项目 CLI `metabot start/status/logs` 依赖 `pm2`，可先 `command -v pm2 || npm install -g pm2 -q`，再执行 `metabot start`。本环境验证后 bridge 监听 `0.0.0.0:9100`，core 服务监听 `127.0.0.1:9200`。
- 2026-07-05 飞书长连接连不上时，日志若出现 `The plain HTTP request was sent to HTTPS port` 或 `tenant_access_token ... undefined`，优先检查 PM2 进程继承的代理环境。`open.feishu.cn`、`*.feishu.cn`、`lark.larksuite.com`、`*.larksuite.com` 需要在 `NO_PROXY/no_proxy` 中绕过代理；已在 `ecosystem.config.cjs` 固化。同 runtime 修改后用 `metabot restart --wait`，切换 runtime 则从外部控制器执行 `metabot deploy-runtime --runtime <dir>`。
- 2026-07-07 轻量 AutoResearchClaw 验证时，memory ingest artifact 必须写到项目根下 `.metabot-memory/autoresearchclaw/<run-id>-output.json`，且 `artifacts[].uri` 只能引用项目根内路径；规划型 dry run 可将不确定结论放入 `memory_event_candidates`，并将最终长期记忆改为 review/staging 流程处理。
- 2026-07-15 MetaMemory → 飞书知识库同步当前限定在 `METABOT_CORE_MEMORY_SERVER_ROOT=/cargo1`；希望出现在飞书 `MetaMemory` 知识空间的文档必须放在 `/cargo1` 下并标记 `shared:true`。曾把 ToDo 写到 `/metabot/todo` 导致飞书侧不可见，已移动到 `/cargo1/todo/metabot-todo-registry` 并通过 `/api/sync/document` 同步成功。
- 2026-07-16 做 live preflight 时确认：根目录 `npm test` 会把 sibling `worktrees/*` 一起纳入 Vitest 搜索，并把 `spike/*.test.ts` 这类无 `describe/it` 的实验文件当成失败用例；做发布前 gate 时优先直接运行聚焦的 `npx vitest run <file...>` 文件列表，不要把根 `npm test` 当成 Agent Team live 验证门禁。
- 2026-07-21 MEM-009 修复后，WorkerManager 对 `autoresearchclaw_output_v2` artifact 必须复用 `validateAutoResearchClawOutput` 深度校验；contract-invalid artifact 只能是 `artifactStatus=invalid` / `contractStatus=violated`，并在 `artifactError.code/message` 暴露原因，不能从失败 worker 恢复为 completed。Legacy candidate aliases 只在受控兼容路径归一化并发出 deprecation telemetry。
- 2026-07-21 MEM-010/FIX-003：`/api/talk/:taskId` 终态 AutoResearchClaw 只把 `currentPhase` 标成 `completed`/`failed`，ingest/review 结果必须作为 Memory Core system-of-record 后续查询元数据呈现；`bin/metabot` 解析 feature CLI 时，source-tree launcher 必须有 `packages/cli/dist/index.js` 才算 ready，`METABOT_DEFAULT_ENV_FILE` 可指向 ready checkout 复用 CLI，env 文件和 PATH/显式 CLI symlink 会先 canonicalize 再做 ready check，但显式坏的 `METABOT_CORE_CLI` 必须 fail-closed。`set -e` 下 `_load_core_cli_config` 在缺少可选 token 时也要显式 `return 0`，否则 delegate 会提前退出。
- 2026-07-22 bridge 由 PM2 以 `node --import tsx src/index.ts` 从**源码**运行（非构建产物），改完 `src/` 只需重启、无需 `npm run build`；`packages/server/dist/index.js` 是独立的 `metabot-core` 进程，不受 `src/` 改动影响。
- 2026-07-22 Claude PTY 冷启动（`--resume` + 6 个 claude.ai 远程 MCP connector）到首个 model turn 可能需要 ~25s，turn-start watchdog 默认 30s 会误杀会话并丢掉用户消息。已在 `.env` 设 `METABOT_CLAUDE_TURN_START_TIMEOUT_MS=90000`（`.env` 由 `src/config.ts` 启动时加载，改后重启即生效，不依赖 PM2 重读 ecosystem）；`watchTurnStart` 现在会在判死前检测「prompt 仍留在 idle 输入框」并补敲一次回车、追加 `METABOT_CLAUDE_TURN_START_RESCUE_MS`（默认 20s）宽限窗口，自救失败才 interrupt + 退役。
- 2026-07-22 MEM-004 review ba812859：`/api/talk/:taskId` 的 Memory Core terminal evidence 解析必须保持 bounded + whitelist-only。不要恢复递归全树扫描或 `unitId` 这类全局 key 推断；只从受信任 Memory Core 容器/形状（如 `result/writes/partial/evidence`、`events.finding/decision`、`promotionRequest`、`search.returned`、`contextPack`）提取 ID。pending review 只能来自显式 pending/review-pending status/phase/boolean，approved/rejected/completed promotion/candidate 不能被标成 pending。遇到 cycle/deep/wide/oversized payload 时应降级为 truncated/no_structured guidance 并指向 Memory Core system-of-record inspect。
- 2026-07-22 MEM-011 发布门禁：根级 TypeScript no-emit 校验统一走 `npm run typecheck`；该脚本显式检查 `tsconfig.bridge.json`、根 solution config 引用的工作区（`packages/cli-core`、`packages/metamemory`、`packages/skill-hub`、`packages/cli`、`packages/server`）和 `packages/web-ui`，顶层旧版 `web/` 不在 no-emit 门禁内，靠 `npm run build:web` / `npm run build` 校验。从仓库根目录运行 CLI Vitest 统一走 `npm run test:cli`，避免误用根级 Vitest 配置。Memory Core / AutoResearchClaw merge semantic-loss sweep 统一走 `npm run check:merge-hygiene:memory-core`；该门禁只在 merge commit 上做 parent-vs-merge 对比，平时非 merge commit 会 skip。
- 2026-07-22 MEM-011 merge-hygiene detector 不能用 raw source substring 扫描自身覆盖到的 test/gate files，否则 adversarial fixtures 会 self-poison；forbidden AutoResearchClaw legacy candidate aliases 应按 TS AST identifier / semantic property name 检测，Git conflict markers 应先 mask comments 与 string/template literals 后再查 raw marker line。该设计保留真实 source-level 检测，同时允许测试中放字符串/注释 fixture。
- 2026-07-22 MEM-011 merge-hygiene lifecycle：GitHub Actions `pull_request` checkout 的 `refs/pull/*/merge` 是 synthetic CI merge，不是发布集成 merge；CI workflow 用 step-level `if: github.event_name != 'pull_request'` 跳过 production parent-vs-merge scan，CLI 本身不做 env-based skip，避免 spoofed PR env 抑制真实 merge commit 扫描。`push` 到真实 merge commit、以及手动/本地 `--merge <ref>` 仍会执行 parent-vs-merge semantic-loss scan；PR 上仍靠 `npm test` 跑 gate 单测/对抗测试。
- 2026-07-22 MEM-011 CLI 测试隔离：`packages/cli/vitest.config.ts` 必须显式 `fileParallelism:false` + `pool:'forks'` + `poolOptions.forks.isolate:true`，且不能启用 `singleFork:true`；Vitest 3 的 `singleFork` 会让多个测试文件共享同一个 child process/global context，CLI 测试替换/修改 `process.env` 和 `vi.stubGlobal` 时会泄漏到后续文件。用 `packages/cli/tests/isolation-env-{a,b}.test.ts` 的双文件行为回归证明 per-file isolation 生效；发布前 canonical `npm test` 需要连续多次稳定通过，不能只用 isolated CLI run 代替。
- 2026-07-23 **worktree 门禁结果可能失真**：worktree 位于 `$METABOT_HOME/worktrees/<name>`，若其中没有自己的 `node_modules`，Node 与 TypeScript 会**向上**查找并命中 `$METABOT_HOME/node_modules`，其 `@xvirobotics/*` 是指向 `$METABOT_HOME/packages/*` 的符号链接——也就是 **`dev` 分支的、已构建的**那一份。结果是你以为在验证 worktree 里的代码，实际部分解析到了 `dev` 的产物，`npm test` / `npm run typecheck` 会假绿。在 worktree 里跑发布门禁前必须先 `npm_config_nodedir=/usr npm_config_strict_ssl=false npm ci`（该 flag 组合规避 node-pty/node-gyp 的 `SELF_SIGNED_CERT_IN_CHAIN`），确认 `ls node_modules/@xvirobotics` 存在且指向本 worktree 的 `packages/*` 后再采信结果。
- 2026-07-23 CI `check` job 的步骤顺序有硬约束：`Build workspace libraries`（构建 `@xvirobotics/cli-core` / `metamemory` / `skill-hub`）**必须早于** `npm run typecheck`。根 typecheck 覆盖 7 个 project，其中 `packages/cli` / `metamemory` / `skill-hub` 经 `exports -> dist/` 导入 cli-core，未构建时报 `TS2307 Cannot find module '@xvirobotics/cli-core/...'`。MEM-011 把该步从 `npx tsc --noEmit`（只查根 bridge project，容忍先于构建）换成 `npm run typecheck` 时未同步调整顺序，且因 CI 只在 push/PR 到 `main`/`dev` 时触发、相关分支从未推送，该顺序一直未被执行到。注意此故障**在本地复现不出来**（本地 TypeScript 的 project-reference source redirect 会绕开缺失的 dist），只能靠 CI 暴露。

<!-- METABOT-WORKER -->

# Worker Agent 规范

本规范只适用于由 PM agent、user 或 admin 明确派发的 Worker 任务。Worker 专注完成被分配的任务。

普通 bot 对话、轻量问答、记忆整理、说明原因、讨论方案等场景中，当前执行者仍是 bot，不应自动套用 Worker 的 `results.json`、`worker-progress.json` 和 `RESULT:` 最后一行输出要求，除非用户或 PM 明确要求按 Worker 任务执行。

## 规则

- GPU 训练：先 `nvidia-smi` 找空闲 GPU，用 `CUDA_VISIBLE_DEVICES` 指定
- 特征构建：NumPy/Pandas 向量化，禁止 Python for 循环
- 安装依赖前先检查：`python3 -c "import xxx" 2>/dev/null || pip install xxx -q`
- 训练日志写入 workdir/train.log
- 所有实验必须用 WandB 记录：`wandb.init(project="<项目名>", entity=os.environ["WANDB_ENTITY"])`（entity 以环境变量 `WANDB_ENTITY` 或 PM 指令中给出的为准）
- Git commit 所有代码改动；**提交前按上方「Git 分支工作流」选对分支**，不同工作流不要混进同一个 commit
- 下载大数据集/模型用学术加速：`bash -c 'source /etc/network_turbo && <命令>'`（仅在该脚本存在的服务器上）
- 获得稳定结论/踩坑经验时，更新本 workdir 的 `CLAUDE.md` / `AGENTS.md`（项目级记忆：环境配置、数据路径、坑、约定，供后续 worker 与 PM 复用）；两个文件是同一份内容的两个引擎入口，**改一个就要同步另一个**（或让 `AGENTS.md` 指向 `CLAUDE.md` 的 symlink）；不要删除其中已有内容

## 结果输出

仅在明确 Worker 任务中，完成后将结果写入 workdir/results.json，格式根据任务类型自定：

```json
{"task": "简述任务", "metrics": {"<指标名>": <数值>, ...}, "notes": "关键发现"}
```

## 进度上报

仅在明确 Worker 任务中，定期更新 workdir/worker-progress.json:

```json
{ "status": "running", "step": "当前步骤描述", "metrics": {}, "timestamp": "ISO8601" }
```

## Worker 返回格式

仅在明确 Worker 任务中，完成后最后一行输出：

```
RESULT: task=[简述] metrics={<指标名>=<数值>, ...} notes=[简短说明]
```

普通 bot 对话不要输出 `RESULT:` 行。
