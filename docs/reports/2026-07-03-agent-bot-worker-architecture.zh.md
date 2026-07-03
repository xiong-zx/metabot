# Agent、Bot、Worker 系统架构报告

日期：2026-07-03
相关群聊：`oc_a0ecfbbf019ae62d91eefb1bc9216a74`
目标仓库：`/root/metabot`

## 来源与限制

本报告用于在删除当前群聊前沉淀上下文和架构决策。可用来源包括：

- 本地 Codex 会话记录：`/root/.codex/sessions/2026/07/*`
- MetaBot 运行日志：`/root/metabot/logs/metabot.log`
- 项目进度文件：`/root/workspaces/projects/metabot-agent-workers/PROGRESS.md`
- 当前仓库文档与代码：`/root/metabot`
- 飞书群基础信息：当前 bot 可读取到群名 `Cargo1`，类型为 group，状态 normal，成员结构为 1 个用户 + 6 个 bot，群主是用户身份而不是当前 bot

飞书历史消息接口在当前 bot 身份下返回 `authorization / user_unauthorized`，且当前机器没有 user 登录态，因此无法直接从飞书导出完整聊天历史。本报告的“群聊总结”基于本地可核验记录，不声称覆盖飞书侧所有原始消息。

## 群聊内容总结

这次群聊围绕把 `/root/newmetabot` 的有效能力迁移到 GitHub clone `/root/metabot`，并把原先一组飞书可见 research bots 收敛成更清晰的 PM、Agent Team、后台 Worker 架构。

主要阶段如下：

1. 用户先要求查看当前各个 agent 的工作目录和权限。系统确认当时注册了 `manager`、`research-pm`、`research-planner`、`research-coder`、`research-experiment`、`research-reviewer` 六个飞书可见 bot，`manager` 是 bypass 权限，其余 research bots 是 `workspace-write + approval=never`。
2. 用户随后说明 `/root/metabot` 是 GitHub 远程仓库 clone，`/root/newmetabot` 有部分改进也有部分落后，要求把仍有价值的能力整合进 `/root/metabot`。同时要求 `manager` 的工作目录为 `/root`，其他 bots 的工作目录为 `/root/workspaces/`。
3. 最初尝试把任务交给 `research-pm`，但它的 sandbox 环境缺少 `worker_dispatch` MCP，shell 又遇到 `bwrap` namespace 问题。随后由 `manager` 直接启动后台 worker，在 `/root/metabot` 上完成第一轮迁移。
4. 第一轮迁移生成了本地 commit `b579cb8e7c6b02c2b87437379b19134fdead9486`，包含 Codex executor、context profile、`developer_instructions`、per-workdir `CODEX_HOME`、rollout fork/token usage、路径说明与测试等改进。
5. 用户继续要求系统性对比 `/root/newmetabot` 和 `/root/metabot`，确认是否所有功能都迁完。审计结论是：PM/worker、Agent Team、Codex 改进等主体已迁，但 `/btw`、长任务 timeout、Feishu WS watchdog、Claude effort、Claude 子进程 `NO_PROXY`、worker 权限透传等仍有缺口。
6. 用户明确要求继续补齐其中的 1、2、3、4、6 项，保持当前群聊免 @ 语义，不兼容旧版 memory/skill-hub bridge 入口。
7. 后续补齐了 worker 权限透传、长任务 timeout 环境变量、`/btw`/`/btwc` 旁路任务、Feishu WebSocket watchdog、Claude effort 和 `NO_PROXY`。验证结果为 `npm run build`、`npm test`、`npm run lint` 均通过，lint 仍是既有 warning。
8. 本轮用户要求在删除群聊前总结群聊内容，给出 agent/bot/worker 设置架构报告，写入 repo，并把设计思路保存到 MetaMemory。

当前重要状态：

- 目标 repo：`/root/metabot`
- 当前分支：`integrate-agent-workers`
- 代码工作树已有大量未提交改动，本报告只新增文档文件。
- 近期 bridge 已经重启完成；按系统提醒，本轮不得再次执行 `metabot restart` 或 `metabot update`。
- 已在后续排障中恢复 metabot-core：`127.0.0.1:9200` 正常监听，`metabot memory health` 与 `mm health` 均可用；本报告已同步到中央 MetaMemory。

## 术语分层

建议在 MetaBot 内部把 bot、agent、worker 分成三层理解：

| 层级 | 生命周期 | 面向对象 | 主要职责 |
| --- | --- | --- | --- |
| Bot | 长期驻留，接 IM/API 入口 | 用户、外部系统、Agent Bus | 鉴权、会话入口、工作目录边界、引擎默认配置、可见性 |
| Agent Team Agent | 长期或半长期，存在于团队 store | lead/PM 与其他队友 | 持久角色、任务队列、邮箱、runs、协作状态 |
| Worker | 短期后台任务 | PM 或 lead agent | 单次实现、实验、验证、长任务，完成后回报结果 |

这个分层的核心思想是：**Bot 是入口和权限边界，Agent 是组织角色，Worker 是一次性执行单元。**

## 推荐运行拓扑

建议常驻配置只暴露少量飞书 bot：

- `manager`：系统管理员入口，工作目录 `/root`，可用于服务运维、repo 管理、部署、紧急修复。它可以拥有最高权限，但不应成为常规 worker 执行者。
- `research-pm`：科研 PM 入口，工作目录 `/root/workspaces`，启用 `pmPrompt`，用于拆任务、监督 worker、维护进度、做最终整合。

planner/coder/experiment/reviewer 不建议继续作为飞书可见 bot。它们应作为 `agentTeams` 中的内部 agent：

- `planner`：研究方案、算法构想、实验设计。
- `coder`：实现代码、重构、测试、工具链。
- `experiment`：跑实验、benchmark、ablation、复现实验。
- `reviewer`：审查结果、找风险、验收实验和代码。

后台 worker 用于更短生命周期的执行任务，例如：

- 在某个 repo worktree 中做一次代码迁移。
- 跑一个长实验并保存日志。
- 对一个失败测试做局部修复。
- 生成报告或 benchmark 汇总。

## 目录约定

推荐目录布局：

```text
/root
├── metabot/                  # MetaBot 自身仓库和运行时
├── newmetabot/               # 旧参考目录，只作迁移来源，不再作为主运行目录
└── workspaces/
    ├── project-a/            # 科研项目 repo
    ├── project-b/            # 另一个科研项目 repo
    └── metabot-agent-workers/
        └── PROGRESS.md       # 跨会话进度记录
```

建议规则：

- `manager.defaultWorkingDirectory = /root`
- `research-pm.defaultWorkingDirectory = /root/workspaces`
- 内部 agents 和 workers 默认在 `/root/workspaces/<repo>` 或隔离 worktree 下执行。
- 不建议把科研 repo 随意散落到 `/root`，除非它确实需要系统级路径访问。默认放 `/root/workspaces/<project>` 更容易做权限边界和 worker 调度。
- 每个长期项目都应有自己的 `AGENTS.md` 或 `PROGRESS.md`，保存项目级工作方式、实验路径、数据路径、坑和当前状态。

## 推荐 bots.json 骨架

以下示例只展示结构，不包含任何 secret：

```json
{
  "feishuBots": [
    {
      "name": "manager",
      "engine": "codex",
      "model": "gpt-5.5",
      "feishuAppId": "cli_xxx",
      "feishuAppSecret": "...",
      "defaultWorkingDirectory": "/root",
      "visible": true
    },
    {
      "name": "research-pm",
      "engine": "codex",
      "model": "gpt-5.5",
      "feishuAppId": "cli_xxx",
      "feishuAppSecret": "...",
      "defaultWorkingDirectory": "/root/workspaces",
      "pmPrompt": true,
      "visible": true
    }
  ],
  "workers": {
    "defaultModel": "gpt-5.4",
    "maxPerPm": 8
  },
  "agentTeamExecutionBot": "research-pm",
  "agentTeams": [
    {
      "name": "research",
      "description": "Internal research team supervised by research-pm",
      "status": "active",
      "displayChatIds": ["oc_a0ecfbbf019ae62d91eefb1bc9216a74"],
      "agents": [
        {
          "name": "planner",
          "role": "planning",
          "engine": "codex",
          "prompt": "Design hypotheses, algorithms, experiment plans, and revision strategies. Do not implement code unless explicitly assigned."
        },
        {
          "name": "coder",
          "role": "implementation",
          "engine": "codex",
          "prompt": "Implement scoped code changes, tests, scripts, and local tooling in the assigned repo/worktree."
        },
        {
          "name": "experiment",
          "role": "experimentation",
          "engine": "codex",
          "prompt": "Run experiments, benchmarks, ablations, collect logs, and summarize reproducible results."
        },
        {
          "name": "reviewer",
          "role": "review",
          "engine": "codex",
          "prompt": "Review code, experiments, claims, failure modes, and missing validation before final reporting."
        }
      ]
    }
  ]
}
```

## 权限策略

建议把权限设计成“默认收紧，按任务放开”：

- `manager` 可用高权限，负责服务和系统级操作。
- `research-pm` 使用次高权限：Codex `approvalPolicy=never` + `sandbox=danger-full-access`，但不使用最高级 `dangerouslyBypassApprovalsAndSandbox`；它负责拆解、调度、验收，系统级操作仍委托给 `manager` / `admin`。
- `worker_dispatch` 应显式传入 `workdir`、`sandbox`、`approval_policy`、`timeout_ms`、`idle_timeout_ms`。
- 常规代码任务使用 `sandbox=workspace-write` 和 `approval_policy=never`。
- 需要跨 repo、系统配置、依赖安装、服务修复时，才由 `manager` 或显式 `danger-full-access` worker 执行。
- 如果 worker 指定了 per-dispatch 权限，应覆盖 bot 级 bypass，避免“用 research-pm 派 worker 却意外继承 manager 级权限”。

示例 worker dispatch 语义：

```json
{
  "workdir": "/root/workspaces/my-paper-code",
  "prompt": "Implement the evaluation script and run the focused tests. Do not modify unrelated files.",
  "label": "eval-script",
  "model": "gpt-5.4",
  "engine": "codex",
  "reasoning_effort": "high",
  "approval_policy": "never",
  "sandbox": "workspace-write",
  "timeout_ms": 14400000,
  "idle_timeout_ms": 1800000
}
```

## 推荐工作流

### 研究项目

1. 用户在飞书里找 `research-pm`，描述目标。
2. `research-pm` 把目标拆成计划、实现、实验、审查四类任务。
3. 如果是长期项目，先在 `/root/workspaces/<project>/PROGRESS.md` 写初始计划。
4. PM 使用 Agent Team 邮箱或任务机制让 `planner`、`reviewer` 做异步分析。
5. 需要实际改代码或跑实验时，PM 用 worker 派发到具体 repo/worktree。
6. Worker 完成后写结果摘要，必要时更新项目 `AGENTS.md` / `PROGRESS.md`。
7. PM 汇总结果、跑最终验证、给用户报告。

### MetaBot 自身维护

1. `manager` 负责 `/root/metabot` 的系统级维护。
2. 改动前检查 `git status`，不要覆盖用户未提交改动。
3. 大任务可让 PM 拆分，但实际执行应固定在 `/root/metabot` 或专用 worktree。
4. 每个迁移任务要求：差异盘点、最小改动、测试、lint、提交或明确未提交原因。
5. 不复制 `.env`、tokens、`bots.json` secrets 到 repo。

## Agent Team 与 Worker 的边界

Agent Team 适合“有身份、有职责、有持续协作关系”的角色。Worker 适合“一次性、可取消、可观察、可超时”的执行。

判断标准：

- 需要长期记忆、收件箱、任务 ownership：用 Agent Team agent。
- 需要跑一段代码、做一次迁移、执行一个实验：用 Worker。
- 需要对外接收用户消息或跨实例可见：用 Bot。
- 需要高权限系统操作：用 `manager` 或显式高权限 worker，不要让普通研究 agent 隐式获得权限。

## 长任务与旁路任务

本次迁移补齐的设计点应该保留：

- `METABOT_TASK_TIMEOUT_MS`：全局任务超时。
- `METABOT_IDLE_TIMEOUT_MS`：无输出空闲超时。
- `METABOT_QUESTION_TIMEOUT_MS`：模型向用户提问后的等待超时。
- Worker 级 `timeout_ms` / `idle_timeout_ms`：长实验按任务覆盖。
- `/btw` / `/btwc`：用于旁路问题，不污染主会话 session，不阻塞主任务。
- `/stop`：应能中止当前主任务和正在跑的 side branch。
- `/reset`：应清理主 session 和 side branch 指针。

## 可观测性与恢复

建议保留以下机制：

- Worker records：记录 worker id、pmChatId、workerChatId、workdir、模型、状态、resultSummary、error。
- Agent Team runs：记录内部 agent 执行历史，供 supervisor 和卡片展示。
- `PROGRESS.md`：跨会话、跨重启的人类可读状态。
- MetaMemory：沉淀架构决策和踩坑经验。
- Feishu WebSocket watchdog：同时根据事件和 raw websocket frame 更新 liveness，静默超时后自动重建。
- 重启提示：bridge 重启后不要重复重启；让恢复会话继续未完成任务。

## 删除当前群聊的处理建议

飞书 OpenAPI / 当前 `lark-cli im` 可用能力里没有找到“直接解散当前群聊”的安全 shortcut。相关能力包括：

- `chat.members.delete`：把用户或机器人移出群，属于 high-risk write，需要确认具体成员，且不等于删除整个群。
- `feed-shortcut-remove`：从当前用户的 feed 里移除会话，必须 user 身份；当前机器没有 user 登录态。
- 群主/管理员在飞书客户端侧解散群聊：这是最符合“删除群聊”的人工路径。

当前群信息显示该群是 `Cargo1`，群主是用户而不是 bot，群内有 1 个用户和 6 个 bot。因此 bot 侧最多只能在具备权限时尝试移除 bot 或成员，不能把这个操作等价为群主解散群聊。

因此本轮没有直接执行删除操作。原因是：

1. 当前任务要求先写报告和保存设计思路；直接删除/退出可能中断交付。
2. 当前 bot 身份读消息历史已被拒绝，user 身份缺失，无法确认群成员和群主权限。
3. 可执行的 OpenAPI 写操作不是“删除群聊”，而是移除成员或移除 feed shortcut，语义不同且有高风险门禁。

建议在确认报告和记忆都已保存后，由群主在飞书客户端解散该群；如果只是让 bot 离开或移除某些成员，需要明确成员 ID，并按 high-risk write 流程确认后执行。

## 最终建议

采用“两 visible bots + 内部 Agent Team + 短期 Workers”的结构：

- 飞书侧只保留 `manager` 和 `research-pm`，降低聊天入口和权限复杂度。
- `manager` 管系统，`research-pm` 管科研项目。
- planner/coder/experiment/reviewer 作为内部 agents，保留职责与协作状态，不污染飞书通讯录。
- 实际代码/实验用 worker 派发到具体 repo/worktree，并显式声明权限和 timeout。
- 所有长期项目放在 `/root/workspaces/<project>`，项目知识写入 repo 内 `AGENTS.md` / `PROGRESS.md`，跨项目架构决策写入 MetaMemory。
