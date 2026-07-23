<div align="center">

# 🤖 MetaBot

### 在飞书 / Telegram / 微信上用手机控制 Claude Code、Kimi Code 或 Codex CLI

*写代码 · 管 Bot · 自动化一切*

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
  <a href="https://feishu.cn"><img src="https://img.shields.io/badge/飞书_/_Lark-00D6B9?style=for-the-badge&logo=lark&logoColor=white" alt="Feishu/Lark"></a>
  <a href="https://telegram.org"><img src="https://img.shields.io/badge/Telegram-26A5E4?style=for-the-badge&logo=telegram&logoColor=white" alt="Telegram"></a>
  <a href="https://ilinkai.weixin.qq.com"><img src="https://img.shields.io/badge/微信_ClawBot-07C160?style=for-the-badge&logo=wechat&logoColor=white" alt="WeChat"></a>
  <img src="https://img.shields.io/badge/Web_UI-61DAFB?style=for-the-badge&logo=react&logoColor=white" alt="Web UI">
</p>

**中文** · [English](README_EN.md) · [📚 文档](docs/)

</div>

> 支持 **Claude Code**、**Kimi Code** 和 **Codex CLI** 三大引擎 — 订阅 / API Key 任你选，每个 Bot 可独立选引擎。

<div align="center">
<table>
<tr>
  <td width="25%"><img src="resources/demo-1.png" alt="召唤 Agent Team" /></td>
  <td width="25%"><img src="resources/demo-2.png" alt="下达任务" /></td>
  <td width="25%"><img src="resources/demo-3.png" alt="Agent 持续工作" /></td>
  <td width="25%"><img src="resources/demo-4.png" alt="PR 已合并" /></td>
</tr>
</table>
<sub>飞书移动端 · 召唤团队 · 下达任务 · 实时跟进 · PR 合并</sub>
</div>

```bash
git clone https://github.com/xiong-zx/metabot.git ~/metabot
cd ~/metabot && bash install.sh
```

安装器引导一切：工作目录 → **引擎选择（Claude / Kimi / Codex）** → 订阅登录 → IM 平台 → PM2 自动启动。**5 分钟上手。**

> 自定义安装目录（默认 `~/metabot`）：把 `~/metabot` 换成你想要的路径即可，或 `METABOT_HOME=/opt/metabot bash install.sh`。Windows: `.\install.ps1 -Dir C:\opt\metabot`。
>
> 也可以一行直装：`curl -fsSL https://raw.githubusercontent.com/xiong-zx/metabot/main/install.sh | bash`。

---

## 🔑 自托管 & 鉴权（个人版）

MetaBot 开箱即是**可自托管的个人版**：本地跑、单 token 鉴权、**不依赖任何 SSO / 企业登录**。

- **本地优先**：`metabot-core` 默认只监听 `http://localhost:9200`，首次启动自动生成本地 API token（写入 `~/.metabot-core/token`）。CLI 与 Web 控制台都用它鉴权。数据默认落在 `~/.metabot-core/`。
- **无需 SSO**：不需要 OAuth / OIDC / 企业 VPN。要多人或公网访问时，自行在前面挂一个反向代理（可选 oauth2-proxy）即可，应用层不强制。
- **分发端点默认上锁**：`/cli/*`、`/install/*` 安装分发端点默认需要 token；确认你的构建不含密钥后，可设 `METABOT_PUBLIC_DISTRIBUTION=1` 放开匿名下载。

---

## 三引擎：Claude Code ✕ Kimi Code ✕ Codex CLI 并列一等支持

MetaBot 不是只绑定一家 — 三大顶级 AI 编码引擎都内置原生支持，**你的订阅直接用**。

| | **Claude Code**（Anthropic） | **Kimi Code**（Moonshot） | **Codex CLI**（OpenAI） |
|---|---|---|---|
| **订阅直连** | ✅ `claude login` OAuth | ✅ `kimi login` | ✅ `codex login`，走 ChatGPT 订阅 |
| **API Key 兜底** | ✅ `ANTHROPIC_API_KEY` / 第三方 Anthropic 兼容端 | ✅ Moonshot API Key | ✅ `OPENAI_API_KEY` / Codex profile |
| **上下文窗口** | 200k（Opus/Sonnet 可选 1M） | 256k（kimi-for-coding） | 400k（gpt-5.x-codex） |
| **工具能力** | Read/Write/Edit/Bash/Glob/Grep/WebSearch/MCP | 同上（Kimi CLI 原生 + `.claude/skills/` 自动发现） | Codex CLI 原生工具链 + `.codex/skills/` 自动发现 |
| **自主运行模式** | `bypassPermissions` | `yoloMode`（等价） | 默认 `--sandbox danger-full-access`，避免无 user namespace 环境下的 `bwrap` 失败 |
| **Claude 项目 subagent** | `.claude/agents/*.md` 自动加载 | 仅内置 `default` / `okabe` | 暂不支持 Claude 项目 subagent；把角色/路由写进 `AGENTS.md` |
| **工作区说明** | `CLAUDE.md` | `AGENTS.md`（安装器自动建软链） | `AGENTS.md`（Codex 官方约定） |

**配置只需一行** — 每个 Bot 独立选引擎：
```json
{ "name": "bulma", "engine": "kimi",   "kimi": { "thinking": true } }
{ "name": "goku",  "engine": "claude" }
{ "name": "vegeta", "engine": "codex", "codex": { "model": "gpt-5.4-codex" } }
```

Codex 支持通过本机 `codex exec --json` CLI 接入，并使用 `codex exec resume` 续接聊天会话。启动 MetaBot 前，请先执行 `codex login` 或配置好 Codex API key/profile。MetaBot 会把飞书侧的 `/<skill-name> ...` 调用统一转成 Codex 的 `$<skill-name> ...` 显式技能调用（例如安装了 `/metaschedule` 后，Codex 会收到 `$metaschedule ...`）。

### Codex 迁移：复用 `.claude` 配置

Claude/Kimi 和 Codex 的发现路径不同。MetaBot 安装、更新和 Skill Hub 安装时会自动镜像内置 skills：

| 内容 | Claude / Kimi | Codex |
|------|---------------|-------|
| 工作区说明 | `CLAUDE.md` | `AGENTS.md` |
| Skills | `.claude/skills/<name>/SKILL.md` | `.codex/skills/<name>/SKILL.md` |
| Claude 项目 subagent | `.claude/agents/*.md` | 不自动加载；迁移为 `AGENTS.md` 里的角色/路由说明 |

已有项目可以直接让 Codex 帮你迁移：

```text
/model codex
请根据当前项目的 .claude 配置，为 Codex 创建对应的 .codex/skills 和 AGENTS.md：
- 把 .claude/skills/* 镜像到 .codex/skills/*
- 根据 CLAUDE.md 生成或更新 AGENTS.md
- 如果存在 .claude/agents/*.md，把这些 subagent 的角色、路由表和工作流整合进 AGENTS.md
```

如果你的宿主机禁用了 unprivileged user namespace，Codex CLI 的 `workspace-write` sandbox 可能在命令执行前报 `bwrap: No permissions to create a new namespace`。MetaBot 的 Codex 默认改用 `danger-full-access` 避开这个问题；需要更强隔离时可以通过 `CODEX_SANDBOX` 或 `codex.sandbox` 显式覆盖。

前端 Bot 用 Claude、后端 Bot 用 Kimi？完全可以。Bot 总线让它们互相委派任务，对面跑什么引擎对调用方透明。

## 术语速查

MetaBot 文档里统一使用下面几类名字，避免把 Bot、Agent 和 Worker 混在一起：

| 名字 | 是什么 | 谁能直接看到 | 怎么创建 |
|------|--------|--------------|----------|
| **Bot** | MetaBot 的常驻入口。可以是飞书/TG/微信/Web 机器人，也可以是只通过 API 调用的 backend bot | 用户可在对应 IM 或 Web UI 里直接对话 | 写在 `bots.json`，或通过 `/api/bots` / `metabot bots` 运行时创建 |
| **Worker** | PM Bot 派出去的一次性后台任务。短生命周期、非阻塞、没有长期聊天身份 | 默认只看到派发结果和回报，不是新的飞书机器人 | 由 PM/user/admin 通过 `worker_dispatch` 或 worker manager 创建 |
| **Agent** | Agent Team 里的内部成员，例如 planner/coder/reviewer。Agent 比 Bot 低一级，由主 Bot 调度；运行时会和主 Bot 之间创建虚拟 chat | 通常通过主 Bot 会话汇报，Web UI Team tab 可看到状态 | 写在 `bots.json` 的 `agentTeams[].agents[]`，或通过 `metabot teams agents spawn` 创建 |
| **Claude 项目 subagent** | Claude Code 项目级 `.claude/agents/*.md` 文件，只由 Claude/Kimi 在本地项目中自动发现 | 不是 MetaBot runtime 对象，Web UI Team tab 不会显示 | 由项目文件、MetaSkill 或手工创建 |
| **Peer** | 另一台 MetaBot 实例上的 Bot 通讯录 | 通过 `metabot talk peer/name` 路由 | 配置 `METABOT_PEERS` |

一句话区分：`bots.json` 里的 `feishuBots` 是用户入口，`agentTeams` 是内部 Agent Team，`workers` 是一次性后台任务默认值；MetaSkill 主要生成项目脚手架和角色文件，不等于自动注册飞书机器人。

`agentTeams` 在当前设计中是 Agent Team Template 的启动种子，不是全局共享运行态。运行时用 `metabot teams instances resolve <template> --chat <chatId>` 生成 chat/project scoped instance；返回的 `instanceId` 可以用在 `metabot teams ... <team>` 位置，避免多个项目共用同一个 team name 串台。

Agent/manager 可以用 `metabot teams proposals create ...` 提出 template 或 RuleSet 更新，worker 只能把候选变更回报给 Agent/manager/PM；只有 PM、用户或 admin 可以 approve/reject。批准后才生成新版本，已运行的 instance 仍保持原先 pin 住的版本。Direct template/rules import、instance resolve、team config 更新以及 Worker 派发/终止/重定向 API/MCP 都需要显式 `actorRole` / `actor_role`；缺省按 `agent` 处理并拒绝，manager/agent 只能向 PM 请求高权限操作。

---

## 你能用它做什么

- **手机写代码** — 地铁上用飞书给 Claude Code / Kimi Code / Codex CLI 发消息，它帮你改 bug、提 PR、跑测试
- **多 Bot 协作** — 前端 Bot、后端 Bot、运维 Bot，各自独立工作空间（甚至独立引擎），通过 Bot 总线互相委派任务
- **知识自生长** — Bot / Worker 把学到的东西存入 MetaMemory，组织每天都在变聪明，无需重新训练
- **自动化流水线** — "每天早上9点搜 AI 新闻，总结 Top 5，存档" — 一句话搞定
- **语音助手（Jarvis 模式）** — AirPods 说 "Hey Siri, Jarvis"，免手免屏语音控制任意 Bot
- **自生长的组织** — 管理者 Bot 按需派发 Worker、调度 Agent Team，安排后续跟进

## 为什么选 MetaBot

| | MetaBot | 直接用 Claude / Kimi / Codex CLI | Dify / Coze |
|---|---|---|---|
| **手机控制** | 飞书/TG/微信随时随地 | 只能在终端 | 有，但不能跑代码 |
| **引擎选择** | Claude ✕ Kimi ✕ Codex 三引擎 | 各自单一 | 无，只能调 API |
| **订阅直连** | 三家原生订阅都直接用 | 一次只能登一个 | 不支持订阅 |
| **代码能力** | 完整 CLI/SDK 工具链（Read/Write/Edit/Bash/MCP） | 完整 | 无 |
| **多执行单元** | Bot 总线 + Worker 派发 + Agent Team | 单会话 | 有，但封闭生态 |
| **共享记忆** | MetaMemory 全文搜索 + 自动同步飞书知识库 | 无 | 无 |
| **科研记忆** | Research Memory Core 自动沉淀实验事实、负结果、决策和 context pack | 无 | 无 |
| **定时任务** | CC 原生 `CronCreate` / `/loop` 即开即用，可选 `/metaschedule` 跨重启持久化 | 仅原生 `CronCreate` / `/loop` | 有 |
| **自主运行** | bypassPermissions / yoloMode，全自动 | 需要人工确认 | 受限于 workflow |
| **开源** | MIT，完全可控 | CLI 开源 | 闭源 SaaS |

## 工作原理

![MetaBot 架构图](resources/metabot.png)

```
飞书/TG/微信 → IM Bridge → Engine Router ──┬─→ Claude Code Agent SDK
                                            ├─→ Kimi Agent SDK（@moonshot-ai/kimi-agent-sdk）
                                            └─→ Codex CLI（codex exec --json 子进程）
                              ↕
                    MetaMemory（共享知识库）
                    Research Memory Core（项目记忆、科研事实、Context Pack）
                    定时调度（CC 原生 CronCreate / /loop；可选 /metaschedule 持久化）
                    Bot 总线（跨 Bot 通信，引擎无关）
                    Agent Team（内部 Agents，非 IM Bot）
                    MetaSkill 脚手架（可选 /metaskill，按需安装）
```

引擎层已抽象 —— Kimi 事件流和 Codex JSONL 都被翻译成 Claude 形状的 `SDKMessage`，流式卡片、工具调用追踪、MetaMemory/调度/Bot 总线在三种引擎下表现一致。

## 自动科研与统一记忆核心

MetaBot 现在可以把科研项目作为长期运行对象管理：用户在飞书里找 `research-pm` 或 `admin` 描述研究目标，MetaBot 负责生成 context pack、派发 AutoResearchClaw worker、收集结构化输出，并把可靠结论沉淀到项目本地的 Research Memory Core。

飞书端不需要输入命令行。常用说法如下：

```
请在 /root/workspaces/proj-alpha 启动一次 AutoResearchClaw 研究循环。
projectId 是 proj-alpha，domain 是 metabot。
目标：验证 context pack 是否能减少重复 prompt。
产出需要包含实验结论、负结果、决策和下一步问题。记忆先进入 review。
```

```
帮我检索 proj-alpha 里关于 context pack 的研究记忆，
只返回可追溯的结论，并说明对应 evidence。
```

```
把这条结论提升为 domain memory：context pack 应在 worker 启动前生成，
worker 不能直接写长期记忆。请先给我看证据，等我批准后再提升。
```

系统架构分为四层：

| 层 | 组件 | 职责 |
|----|------|------|
| Control Plane | 飞书 / Web / Bot 总线 / PM Agent | 接收用户意图、调度 Agent Team 和 worker、发起审批，不保存科研事实 |
| Execution Engine | AutoResearchClaw worker | 单项目 research loop：文献/假设/实验/代码/结果/报告，产出固定 JSON contract |
| Memory Core | Event Ledger + Curator + Context Pack Builder + ProjectMem/Semantic Provider | 保存项目本地 append-only memory events，生成 memory units，检索和压缩上下文，控制 promotion/supersede/redaction |
| Human Memory | MetaMemory + 飞书知识库 + 项目 `AGENTS.md` | 保存人类可读总结、周报、架构记录和稳定项目规则，不作为执行关键事实源 |

设计边界：

- worker 和 AutoResearchClaw 只产出结构化结果，不直接写 domain/global 长期记忆。
- project/private 记忆可以由 curator 写入；domain/global 记忆必须通过 promotion 和用户审批。
- context pack 是低 token 运行上下文，默认只注入 active、未 redacted、未 superseded 的记忆。
- MetaMemory 保存人类可读总结；Research Memory Core 保存可追溯、可审计、可检索的执行记忆。

详细使用说明见 [自动科研系统](docs/features/auto-research.zh.md) 和 [Memory Core](docs/features/memory-core.zh.md)。

## 仓库布局（Monorepo）

MetaBot 从 2026-05-19 起把 `metabot-core` 合并进同一个 monorepo（npm workspaces）。这里有两个常见名词：

- **bridge**：仓库根目录的运行时服务。它连接飞书/TG/微信/Web，维护聊天会话，启动 Claude/Kimi/Codex，引导 Worker 和 Agent Team。PM2 里跑的 `metabot` 主要就是 bridge。
- **metabot-core**：`packages/server` 里的中心 HTTP 服务，提供 MetaMemory、Skill Hub、Agents/T5T、token 分发等共享能力。它可以和 bridge 在同一台机器，也可以单独部署成中心服务。

Bridge 运行时仍在仓库根目录，吸收进来的中心服务侧在 `packages/` 下面：

```
metabot/                       # 仓库根 —— bridge 运行时（bot 主机用 PM2 跑）
├── src/                       # bridge 引擎、流处理、Feishu/Telegram/微信桥接
├── bin/                       # CLI（metabot 单一入口 / doubao-tts）
├── web/                       # bridge 自带的浏览器 SPA
├── packages/                  # 吸收进来的 metabot-core
│   ├── server/                # 中心 HTTP 后端（ECS 部署单元）
│   ├── cli/                   # `metabot <子命令>` 功能 CLI 实现
│   ├── web-ui/                # 中心 SPA（Vite，编译后由 server/static/ 提供）
│   ├── cli-core/              # CLI/客户端共享底层
│   ├── metamemory/            # /api/memory 的瘦客户端
│   ├── skill-hub/             # /api/skills 的瘦客户端
│   └── skills/                # 默认 skill bundle 源（metabot SKILL.md）
└── docs/                      # 全量文档
```

两半之间**只通过 HTTP `/api/*` 通信**，不允许跨包 import（由 ESLint `no-restricted-imports` + `packages/server/package.json` exports 锁双重护栏）。Bridge 主机的 `install.sh` 只安装 bridge 自己 + CLI/CLI-Core 所需依赖，**不会**拉中心服务专属的 fastify / react / vite / 服务端 better-sqlite3。中心 server 部署仍走 `cd packages/server && bash deploy/install.sh`（脚本内部用 `$PKG_DIR`，不受路径迁移影响）。

## 多端接入

MetaBot 支持 4 种方式与你的 Bot 和执行单元交互：

| 客户端 | 场景 | 特色功能 |
|--------|------|---------|
| **飞书/Lark** | 工作场景，团队协作 | 流式交互卡片、@mention 路由、知识库自动同步 |
| **Telegram** | 个人/国际用户 | 30 秒配置、长轮询无需公网 IP、群聊 + 私聊 |
| **Web UI** | 浏览器端，语音对话 | 电话语音模式（VAD）、RTC 实时通话、MetaMemory 浏览器、团队看板 |

| 支柱 | 组件 | 作用 |
|------|------|------|
| **受监督** | IM Bridge | 实时流式卡片展示每一步工具调用。人类看到 Bot / Worker 做的一切 |
| **自我进化** | MetaMemory | 共享知识库。Bot / Worker 写入学到的东西，其他执行单元检索引用 |
| **执行组织** | Bot 总线 + Worker + Agent Team + 调度（可选 MetaSkill / MetaSchedule） | Bot 互相委派任务，PM Bot 按需派 Worker 或 Agent；用 CC 内置 `CronCreate` / `/loop` 即可定时；要跨重启可装可选 `/metaschedule` |

## Web UI

浏览器端全功能聊天界面，部署即可用。访问地址：`https://your-server/web/`

![MetaBot Web UI](resources/web-ui.png)

- **实时流式聊天** — WebSocket 推送，Markdown 渲染，工具调用展示
- **电话语音模式** — 点击电话图标，全屏免手对话，VAD 自动检测说完
- **RTC 实时通话** — 基于火山引擎 RTC 的双向语音/视频通话
- **群聊模式** — 多个 Bot 或 Agent 在一个对话中协作，@mention 路由
- **MetaMemory 浏览器** — 搜索和浏览共享知识库
- **团队看板** — 查看 Bot / Agent Team 状态概览
- **文件支持** — 上传/下载文件，内联预览
- **明暗主题** — 跟随系统或手动切换

**技术栈**：React 19 + Vite + Zustand + react-markdown

> 语音功能需要 HTTPS。推荐用 Caddy 反向代理，自动管理证书。详见 [Web UI 文档](docs/features/web-ui.zh.md)。

## 核心能力

| 组件 | 一句话说明 |
|------|-----------|
| **三引擎内核** | 每个 Bot 独立选 Claude Code / Kimi Code / Codex CLI — 完整工具链（Read/Write/Edit/Bash/Glob/Grep/WebSearch/MCP），自主模式运行 |
| **常驻会话与目标循环** | 每个会话一个常驻引擎会话 — `/goal` 让 Bot 在多轮之间持续自驱直到目标达成；Agent Team agents 和后台任务跨轮存活 |
| **Agent Team（内部 Agents）** | PM/主导 Bot 并行派遣多个专家 Agent，路由任务、汇总结果 —— 全部可在一个飞书会话中完成 |
| **AutoResearchClaw** | 通过 `research-pm` 从飞书启动单项目 research loop，自动生成 context pack、派发 worker、收集结构化科研结果 |
| **Research Memory Core** | 项目本地 append-only 科研记忆核心，沉淀 facts、decisions、negative results、open questions，并为 worker 生成低 token context pack |
| **CC 原生调度** | 直接用 Claude Code 内置的 `CronCreate` / `/loop` —— 即开即用，会话内最简单 |
| **MetaMemory** | 由 metabot-core 服务（本地自托管，默认 `http://localhost:9200`）提供的共享知识库，全文搜索；MetaBot 通过 `/api/memory/*` 读写，并可同步到飞书知识库 |
| **IM Bridge** | 飞书、Telegram、微信（含手机端）对话任意 Bot，流式卡片 + 工具调用追踪 |
| **Bot 总线 / Peers** | Bot 通过 `metabot talk` 互相对话，可运行时创建/删除 Bot 配置，并可跨 MetaBot 实例路由 |
| **MetaSchedule（可选）** | 跨重启的服务端定时调度器，Cron + 一次性延迟，HTTP API + `metabot schedule` CLI。默认不装，按需 `cp src/skills/metaschedule/SKILL.md` 启用 |
| **MetaSkill（可选）** | 团队脚手架。`/metaskill` 一键生成可迁移的项目角色文件、Claude 项目 subagent 或 Skill。默认不装，按需 `cp src/skills/metaskill/` 启用 |
| **飞书 Lark CLI** | 200+ 命令覆盖文档、消息、日历、任务等 11 大业务域，19 个 AI skills |
| **Skill Hub** | 中心化技能共享注册中心。`metabot skills` 发布、发现、安装技能，FTS5 全文搜索（由 metabot-core 提供）|
| **Peers 联邦** | 跨实例 Bot 发现和任务路由，`metabot talk alice/backend-bot` 自动路由 |
| **语音助手** | Jarvis 模式 — AirPods 说 "Hey Siri, Jarvis" 语音控制 Bot |

## 快速开始

### Telegram（30 秒）

1. 找 [@BotFather](https://t.me/BotFather) → `/newbot` → 复制 token
2. 写入 `bots.json` → 完成（长轮询，无需 Webhook）

### 微信（灰测中）

1. iPhone 微信 8.0.70+ → 设置 → 插件 → 开启 **ClawBot**
2. 运行 `install.sh`，选 `3) WeChat ClawBot` — 扫码绑定
3. 详见 [微信接入指南](docs/features/wechat.zh.md)

### 飞书

1. [open.feishu.cn](https://open.feishu.cn/) 创建应用 → 添加「机器人」能力
2. 开通权限：`im:message`、`im:message:readonly`、`im:resource`、`im:chat:readonly`
3. 先启动 MetaBot，再开启「长连接」+ `im.message.receive_v1` 事件
4. 发布应用

> 不需要公网 IP。飞书用 WebSocket，Telegram 和微信用长轮询。

**Web UI**：启动 MetaBot 后访问 `http://localhost:9100/web/`，输入 API_SECRET 即可使用。

## 示例 Prompt

刚接触 MetaBot？以下是你可以直接在飞书/Telegram 中发送的真实 prompt：

### MetaMemory — 持久化知识库

```
把我们刚讨论的部署方案写入 MetaMemory，放到 /projects/deployment 下面。
```

```
搜索一下 MetaMemory 里有没有关于 API 设计规范的文档。
```

### 定时任务（Claude Code 原生）

直接用 CC 内置的 `CronCreate` 和 `/loop`，会话内即开即用：

```
设个每天早上9点的定时任务：搜索 Hacker News 和 TechCrunch 的 AI 新闻，
总结 Top 5，保存到 MetaMemory。
```

```
/loop 每隔 5 分钟检查一下 PR #123 的 CI 状态，跑完为止
```

> 想跨重启活下来、其他 Bot 也能看到/取消？装可选的 `/metaschedule` skill
> （`cp src/skills/metaschedule/SKILL.md ~/.claude/skills/metaschedule/`），
> 就能用 `metabot schedule cron` / HTTP API 提交到 MetaBot 服务端调度器。

### Agent Team — 内部 Agent 协作

```
你来当主导工程师。用 Agent Team 并行派出一个前端 Agent 和一个后端 Agent：
前端负责 React UI 改造，后端加上新的 /api/reports 接口，
你负责 review 两边的 PR，全部通过后再合并。
```

### 目标循环

```
/goal PR #123 的 CI 全绿、部署成功。
每 10 分钟检查一次，搞定后告诉我。
```

### MetaSkill — 团队脚手架（可选）

`/metaskill` 默认不装。先启用：`cp -r src/skills/metaskill ~/.claude/skills/`，然后：

```
/metaskill 给这个 React Native 项目创建一套团队脚手架 ——
我需要一个前端专家、一个后端 API 专家、一个 code reviewer。
```

### Bot-to-Bot 协作

```
把这个 bug 委派给 backend-bot 处理："修复 /api/users/:id 的空指针异常"。
```

```
让 frontend-bot 更新仪表盘 UI，同时让 backend-bot 加上新的 API 接口。
两边都把进度记录到 MetaMemory。
```

### 组合工作流

```
读一下这个飞书文档 [粘贴链接]，提取产品需求，拆成任务，
然后设一个每天下午6点的定时任务，对照需求跟踪开发进度。
```

```
（先 cp src/skills/metaskill 到 ~/.claude/skills/ 以启用 /metaskill）
/metaskill 创建一个 "daily-ops" 项目角色，让它每天早上8点跑：
检查服务健康状态、review 昨晚的错误日志、发一份运维摘要。
```

## 飞书使用技巧

<details>
<summary><strong>私聊 vs 群聊</strong></summary>

| 场景 | @提及 | 说明 |
|------|-------|------|
| **私聊** | 不需要 | 所有消息直接发送给 Bot |
| **1对1 群聊**（你 + Bot 两人群） | 不需要 | 自动识别为类私聊 |
| **多人群聊** | 需要 @Bot | 只有 @Bot 的消息才会触发回复 |

> **推荐**：建一个只有你和 Bot 的两人群聊。不需要每次 @Bot，又能保留群聊的好处（置顶、分类管理）。

</details>

<details>
<summary><strong>发送文件和图片</strong></summary>

**私聊 / 两人群**：直接发送文件或图片，Bot 自动处理。支持多文件批量发送（2 秒内自动合并）。

**多人群聊**：飞书限制 — 上传文件时无法同时 @Bot。解决方案：**先传后 @**

1. 先在群里上传文件或图片
2. 5 分钟内 @Bot 说「分析一下」
3. Bot 自动把你之前上传的文件附上

支持的消息类型：文本、图片（Claude 多模态）、文件（PDF/代码/文档）、富文本（Post 格式）、多文件批量。

</details>

## 配置

**`bots.json`** — 定义你的常驻 Bot，以及可选的 Agent Team：

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

`feishuBots` / `telegramBots` / `webBots` 是用户可直接对话的入口 Bot；`agentTeams` 是内部 Agent 配置，不会自动创建新的飞书机器人；`workers` 只定义一次性后台任务的默认值。

`agentTeams` 更准确地说是 Agent Team Template seed。一个飞书聊天/项目应解析成独立 Agent Team Instance；`metabot teams instances resolve` 返回的 `instanceId` 可作为后续 `metabot teams` 命令里的 `<team>` 参数。

如果项目经验需要沉淀成共享 template/rules，Agent/manager 先创建 promotion proposal，再由 PM、用户或 admin 批准；worker 不直接创建 proposal。批准只写入新的版本，不会自动改变正在跑的科研项目。

<details>
<summary><strong>所有 Bot 配置字段</strong></summary>

| 字段 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `name` | 是 | — | Bot 标识名 |
| `defaultWorkingDirectory` | 是 | — | Claude 的工作目录 |
| `feishuAppId` / `feishuAppSecret` | 飞书 | — | 飞书应用凭证 |
| `telegramBotToken` | Telegram | — | Telegram Bot Token |
| `wechatBotToken` | 微信(可选) | — | 预认证 iLink token（不填则 QR 登录） |
| `maxTurns` / `maxBudgetUsd` | 否 | 不限 | 执行限制 |
| `model` | 否 | SDK 默认 | Claude 模型 |
| `effort` | 否 | Claude 默认 | Claude 推理强度：`low` / `medium` / `high` / `xhigh` / `max` |
| `permissionMode` | 否 | root 下 `auto`，非 root 下 `bypassPermissions` | Claude Code 工具权限模式：`default` / `acceptEdits` / `bypassPermissions` / `plan` / `dontAsk` / `auto` |
| `apiKey` | 否 | — | Anthropic API Key（不设则从 `~/.claude/.credentials.json` 动态读取，兼容 cc-switch） |
| `pmPrompt` | 否 | `false` | 启用研究 PM 行为契约和 1 小时 worker 巡检提醒 |
| `visible` | 否 | `true` | Bot 是否对其他 bot / Bot 总线可见，可被 `metabot talk` 触达。每次 bridge bulk-register 都按 bots.json 回写（不 sticky）|
| `memoryPublic` | 否 | `true` | `metabot memory create/mkdir` 不带 `--path` 时的默认落点：`true` = `/shared/<bot>`（其他人可读），`false` = `/users/<bot>`（私有）。显式传 `--path` 永远以传入为准。bots.json 不写则保留 `metabot memory visibility` CLI 上次设置（sticky）|

全局字段：

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `workers.defaultModel` | `gpt-5.4` | `worker_dispatch` 默认模型 |
| `workers.maxPerPm` | `8` | 每个 PM chat 最多同时运行的 worker 数 |
| `agentTeamExecutionBot` | 自动回退 | Agent Team supervisor 用来执行 Agent run 的 Bot，建议设为 `research-pm` 或内部 worker，避免落到 `manager` |

`agentTeams[].agents[]` 定义 Agent Team 里的 Agent，并支持成员级执行覆盖：

| 字段 | 说明 |
|------|------|
| `engine` / `model` | 该成员使用的引擎和模型，例如 reviewer 用 `codex` + `gpt-5.5` |
| `reasoningEffort` | 该成员的推理强度：`minimal` / `low` / `medium` / `high` / `xhigh` / `max` |
| `approvalPolicy` / `sandbox` | Codex 权限边界，例如 reviewer 用 `approvalPolicy: "never"` + `sandbox: "read-only"` |
| `timeoutMs` / `idleTimeoutMs` | 单次成员 run 的总超时和无输出超时 |
| `allowedTools` | Claude 工具白名单；不设置则使用 bot 默认工具策略 |

</details>

<details>
<summary><strong>环境变量 (.env)</strong></summary>

| 变量 | 默认 | 说明 |
|------|------|------|
| `API_PORT` | 9100 | HTTP API 端口 |
| `API_SECRET` | — | Bearer 认证（同时保护 API 和 Web UI） |
| `METABOT_CORE_URL` | `http://localhost:9200` | metabot-core 服务地址（MetaMemory + Skill Hub + Agents + T5T），本地自托管或填你自己的远程地址 |
| `METABOT_CORE_PUBLIC_URL` | 读 `METABOT_CORE_URL` | metabot-core 对外可访问地址；用于分发安装脚本和 core→bridge 回调，反向代理场景建议显式设置 |
| `METABOT_CORE_TOKEN` | 读 `~/.metabot-core/token` | metabot-core Bearer Token（在 `<METABOT_CORE_URL>/cli` 自助生成） |
| `METABOT_CORE_MEMORY_WRITE_ROOTS` | `/users,/shared,/metabot` | 公开 Memory API 允许写入的顶层路径，逗号分隔 |
| `METABOT_CORE_MEMORY_SERVER_ROOT` | — | 本服务器的 MetaMemory 顶层命名空间，例如 `/cargo1`；设置后会加入 Memory API 可写根 |
| `METABOT_ASYNC_TASK_STALE_MS` | `86400000` | `/api/talk?async=true` 任务超过该时长仍未完成时标记为 `task_expired` |
| `WIKI_SYNC_ENABLED` | true | 启用 MetaMemory→飞书知识库同步 |
| `WIKI_SPACE_NAME` | MetaMemory | 飞书知识库空间名称 |
| `WIKI_AUTO_SYNC` | true | 轮询 MetaMemory 变更并自动触发同步 |
| `WIKI_AUTO_SYNC_POLL_MS` | `60000` | MetaMemory 快照轮询间隔 |
| `WIKI_AUTO_SYNC_DEBOUNCE_MS` | `5000` | 自动同步防抖时间 |
| `WIKI_SYNC_STATE_DIR` | `./data` | Wiki 同步映射 SQLite 存放目录 |
| `VOLCENGINE_TTS_APPID` | — | 豆包语音（TTS + STT） |
| `VOLCENGINE_TTS_ACCESS_KEY` | — | 豆包语音密钥 |
| `METABOT_URL` | `http://localhost:9100` | MetaBot API 地址 |
| `METABOT_PEERS` | — | Peer MetaBot 地址（逗号分隔） |
| `LOG_LEVEL` | info | 日志级别 |

</details>

<details>
<summary><strong>第三方 AI 服务商（国产模型）</strong></summary>

支持 Kimi、DeepSeek、GLM 等 Anthropic 兼容 API：

```bash
ANTHROPIC_BASE_URL=https://api.moonshot.ai/anthropic    # Kimi/月之暗面
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic   # DeepSeek
ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic       # GLM/智谱
ANTHROPIC_AUTH_TOKEN=你的key
```

</details>

<details>
<summary><strong>cc-switch 兼容</strong></summary>

兼容 [cc-switch](https://github.com/farion1231/cc-switch)、[cc-switch-cli](https://github.com/SaladDay/cc-switch-cli)、[CCS](https://github.com/kaitranntt/ccs) 等认证切换工具。用 `cc switch` 切换 API/订阅模式后，MetaBot **无需重启**即可生效。

如需固定使用某个 API Key，在 `bots.json` 中设置 `apiKey` 字段。

</details>

<details>
<summary><strong>安全</strong></summary>

MetaBot 默认以 root-aware 模式运行 Claude Code：root 进程使用 `auto`，非 root 进程使用 `bypassPermissions`。可在 `bots.json` 的 Claude bot 顶层设置 `permissionMode` 覆盖：

```json
{
  "name": "pm-claude",
  "engine": "claude",
  "permissionMode": "auto"
}
```

注意：

- Claude 对工作目录有完整读写执行权限
- `bypassPermissions` 会跳过权限检查，权限边界主要来自运行用户、容器和工作目录
- `plan` 只规划不执行工具，适合只做设计审阅的 bot
- 通过飞书/Telegram/微信平台设置控制访问
- 用 `maxBudgetUsd` 限制单次花费
- `API_SECRET` 保护 API 服务器
- MetaMemory 由中心 metabot-core 服务托管，认证与 ACL 在中心侧统一管理

</details>

## 聊天命令

| 命令 | 说明 |
|------|------|
| `/reset` | 清除会话 |
| `/stop` | 中止当前任务 |
| `/status` | 查看会话状态（含当前模型） |
| `/goal <条件>` | 设置目标，Bot 跨多轮持续推进直到达成。`/goal clear` 停止 |
| `/model` | 查看当前模型；`/model list` 查看可用模型；`/model <name>` 切换；`/model reset` 恢复默认 |
| `/memory list` | 浏览知识库目录 |
| `/memory search 关键词` | 搜索知识库 |
| `/sync` | 同步 MetaMemory 到飞书知识库 |
| `/metaskill ...` | 生成团队脚手架、Claude 项目 subagent 或 Skill（可选 skill，默认不装） |
| `/help` | 帮助 |

> **模型切换**：每个会话可独立设置模型，默认 `claude-fable-5`。Fable 5 使用 Claude Code 原生 1M 上下文、128k max output 和 adaptive thinking；Opus/Sonnet 仍默认保持 200k 上下文，可在模型名后加 `[1m]` 启用 1M，例如 `/model claude-opus-4-8[1m]`。
> **Codex Skill 调用**：飞书里发的 `/<skill> ...` 在 Codex 会话下会被 MetaBot 自动改写成 `$<skill> ...`，例如 `$metaschedule ...`。

<details>
<summary><strong>API 参考</strong></summary>

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/health` | 健康检查（无需认证）— 仅返回 `{ status, uptime }` |
| `GET` | `/api/status` | 详细状态：Bot 数、peer、定时任务（需认证） |
| `GET` | `/api/bots` | 列出 Bot（本地 + Peer） |
| `POST` | `/api/bots` | 运行时创建 Bot |
| `DELETE` | `/api/bots/:name` | 删除 Bot |
| `POST` | `/api/talk` | 与 Bot 对话（自动路由到 peer） |
| `GET` | `/api/peers` | 列出 Peer 及状态 |
| `POST` | `/api/schedule` | 创建定时任务 |
| `GET` | `/api/schedule` | 列出定时任务 |
| `PATCH` | `/api/schedule/:id` | 更新定时任务 |
| `DELETE` | `/api/schedule/:id` | 取消定时任务 |
| `POST` | `/api/sync` | 触发 Wiki 同步 |
| `GET` | `/api/stats` | 费用与使用统计 |
| `GET` | `/api/metrics` | Prometheus 监控指标 |
| `POST` | `/api/tts` | 文字转语音 |
| `GET` | `/api/skills` | 列出技能（本地 + Peer） |
| `GET` | `/api/skills/search?q=` | 全文搜索技能 |
| `GET` | `/api/skills/:name` | 获取技能详情 |
| `POST` | `/api/skills` | 发布技能 |
| `POST` | `/api/skills/:name/install` | 安装技能到 Bot |
| `DELETE` | `/api/skills/:name` | 删除技能 |

</details>

<details>
<summary><strong>CLI 工具</strong></summary>

安装器将 `metabot` 放到 `~/.local/bin/`，安装后立即可用。`metabot` 是**唯一的 CLI 入口**，三类命令：(1) bridge 进程控制（`update` / `start` / `stop` / `restart` / `logs` / `status`）；(2) bridge 守护进程 API（`bots` / `talk` / `schedule` / `peers` / `stats` / `voice` / `health`，curl 本地 `localhost:9100`）；(3) 其余（`t5t` / `agents` / `memory` / `skills`）转发给本仓库 monorepo 内 `packages/cli/bin/metabot` 提供的 metabot-core 功能 CLI。旧的 `mb`/`mm`/`mh` CLI 与 `metamemory`/`skill-hub` skill bundle 已下线（安装/更新时会自动清掉 `~/.local/bin/` 里的残留）。

```bash
# 1. MetaBot 进程管理（bin/metabot 直接处理）
metabot update                      # 拉取最新代码，重新构建，更新 skills，重启
metabot start / stop / restart      # PM2 管理；restart 仅用于当前 runtime
metabot deploy-runtime --runtime DIR # 从 SSH/独立控制器原子切换 worktree/runtime
metabot logs                        # 查看实时日志
metabot status                      # PM2 进程状态

# 2. bridge 守护进程 API（curl 本地 localhost:9100）
metabot bots                        # 列出所有 Bot
metabot talk [--async|--sync] [--no-cards] [--wait-ms N] <bot> <chatId> <prompt> # 与 Bot 对话；默认最多等 25 秒，超时返回 taskId
metabot talk-status <taskId>        # 查询 async talk 任务状态
metabot stats                       # 费用和使用统计
metabot voice tts "你好世界" --play  # 文字转语音

# 3. 功能子命令（转发给 metabot-core 功能 CLI）
metabot t5t board                   # 团队日报看板
metabot agents list                 # 对端 Bot 通讯录
metabot memory search "部署指南"     # 共享记忆全文搜索
metabot memory visibility           # 查看当前 bot 默认写 public 还是 private
metabot memory visibility private   # 切到 private（默认写 /users/<bot>，仅自己可读）
metabot skills list                 # 技能仓库（中心 Skill Hub）
# 覆盖 metabot-core CLI 路径：export METABOT_CORE_CLI=/path/to/packages/cli/bin/metabot

# 定时任务 — 推荐 CC 原生：直接在 Claude Code 里用 CronCreate / /loop。
# 跨重启的服务端调度（metabot schedule list / cron / cancel / pause / resume）
# 由可选 /metaschedule skill 提供，按需安装：
#   cp src/skills/metaschedule/SKILL.md ~/.claude/skills/metaschedule/

# 飞书 Lark CLI（飞书 Bot 专属）
lark-cli docs +fetch --doc <飞书链接>
lark-cli im +messages-send --chat-id oc_xxx --text "Hi"
lark-cli calendar +agenda --as user

# 文字转语音
metabot voice tts "你好世界" --play
```

`metabot update` 会自动更新已安装的 `lark-cli` 和飞书/Lark skills，并同步到 bot 工作目录；新机器首次安装时仍由安装器引导是否启用飞书 skills。

CLI 支持连接远程 MetaBot 服务器，在 `~/.metabot/.env` 配置 `METABOT_URL` 即可；MetaMemory / Skill Hub / Agents / T5T 由 metabot-core 统一提供，配置 `METABOT_CORE_URL` + `METABOT_CORE_TOKEN`，在 `<METABOT_CORE_URL>/cli` 自助获取 Token。从中心 metabot-core 的 `/install/install.sh` 安装新服务器时，脚本会自动把请求来源注入为默认 `METABOT_CORE_URL`；反向代理或内外网地址不一致时，在中心 core 上显式设置 `METABOT_CORE_PUBLIC_URL`。

</details>

<details>
<summary><strong>手动安装</strong></summary>

```bash
git clone https://github.com/xiong-zx/metabot.git
cd metabot && npm install
cp bots.example.json bots.json   # 编辑 Bot 配置
cp .env.example .env              # 编辑全局设置
npm run dev
```

前置条件：Node.js 20+、native 编译工具（Linux: `python3 make g++`；macOS: Xcode Command Line Tools），[Claude Code CLI](https://github.com/anthropics/claude-code) 已安装并认证。使用 `install.sh` 时这些会自动检查/提示安装；如果手动 `npm install` 时 node-gyp 下载 Node headers 被证书/代理拦截，且系统有 `/usr/include/node`，可先执行 `export npm_config_nodedir=/usr`。

</details>

## 开发

```bash
npm run dev          # 热重载开发服务器（tsx）
npm test             # 运行测试（vitest）
npm run lint         # ESLint 检查
npm run build        # TypeScript 编译
```

## Roadmap

- [ ] 插件市场（MCP Server 一键安装）
- [ ] 更多 IM 平台（Slack、Discord、钉钉）

## 关于

MetaBot 由 [XVI Robotics](https://xvirobotics.com) 打造（人形机器人大脑公司）。我们在内部用 MetaBot 把公司打造成 **AI-native 组织** —— 一个小团队的人类，监督自我进化的 Bot、Agents 和 Workers。

我们开源它，因为我们相信这是未来公司的运行方式。

## License

[MIT](LICENSE)
