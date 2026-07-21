# Agent 团队

MetaBot Agent 团队让用户面对的 Bot / PM 通过本地 bridge 协调一组内部 Agent。协调模型是引擎中立的：团队可以声明 Claude、Codex 或 Kimi Agent，所有协调状态都落在 bridge 数据库里，而不是藏在单个模型会话中。实际执行仍走当前 bridge 和 session-engine 路径，因此每个配置的引擎都必须被该 bridge 运行时支持。

## 功能

Agent 团队用于更大的运行时协作：

- **Agent Team Template** 定义默认 agents、shared prompts、skills、workflow policy、quality gates 和默认执行参数。
- **Agent Team Instance** 是某个聊天/项目里的运行态，持有独立 agents、邮箱消息、共享任务、runs、虚拟 chat 和 activity card。
- **PM Bot** 创建或复用团队实例，分配任务，并整合对用户的最终结果。
- **Agent** 运行在执行该团队的 bridge 上的独立会话里。Legacy team 使用 `team:<team>:<agent>`；scoped runtime instance 使用 `teaminst:<instanceId>:<agent>`。
- Agents 通过 `metabot teams` 协调，因此进展对 PM、其他 Agents、飞书卡片和后续 supervisor 自动化都是可见的。

这是 [MetaSkill](metaskill.md) 的运行时对应：MetaSkill 生成可移植的团队 prompts 和 skills；Agent 团队负责运行一个真实团队。

## 目标模型：Template / Instance / Pinning

`bots.json` 中的 `agentTeams` 应作为可启动的 **Agent Team Template**，不是全局共享运行态。bridge 启动或导入配置时，把这些模板写入 versioned template store；运行时每个聊天/项目创建自己的 **Agent Team Instance**。

关键规则：

- Template 可以共享，runtime instance 必须隔离。
- 默认 scope 是 `chat`：一个飞书聊天窗口对应一个项目实例。
- `project` scope 需要显式 `projectId`，用于多个聊天共享一个项目。
- `global` scope 只用于少数公共运维/跨项目专家组，必须显式开启，不作为默认。
- 每个 instance 必须 pin 到不可变的 `templateId@version` 和内容 digest。
- Template 更新不会自动改变正在运行的 instance；升级必须生成 diff/migration plan，并由 PM 或用户批准。
- Instance 可以保留旧版本、手动 refresh 到新版本，或在失败时回滚到旧 pin。

示例：

```text
Template: research-codex v3

Instance: research-codex@chat:oc_project_a
  pinned_template: research-codex v2
  PM: pm-codex
  virtual chats:
    teaminst:<instanceId>:manager
    teaminst:<instanceId>:planner
    teaminst:<instanceId>:coder

Instance: research-codex@chat:oc_project_b
  pinned_template: research-codex v3
  PM: pm-claude
  virtual chats:
    teaminst:<instanceId>:manager
    teaminst:<instanceId>:planner
    teaminst:<instanceId>:reviewer
```

当前实现仍保留兼容 legacy `teamName` 的 CLI/API selector，但 scoped runtime instance 已经把 child rows 写入 `instance_id`，并把 Agent 执行会话改为 `teaminst:<instanceId>:<agent>`。剩余风险主要在旧的 `teamName` 协调入口以及还没完全 instance-keyed 的 activity/recovery 路径。

## 权限边界：PM / Manager / Agent / Worker

PM 和 team manager 不是同一级角色：

| 角色 | 可以做 | 不应做 |
| --- | --- | --- |
| PM Bot | 创建/绑定 team instance、在配额内创建或停止 Agents、批准 template/rules 升级、批准 `worker_dispatch`、面向用户汇报 | 直接把未审批的项目经验写成全局 template/rules |
| Team manager Agent | 协调内部 Agents、维护内部 tasks、汇总状态、发现阻塞、向 PM 请求 worker 或审批 | 创建新 Agents、执行 `worker_dispatch`、重启服务、提升 template、修改高权限 rules |
| 普通 Agent | 完成自己的 planner/coder/experiment/reviewer 职责，产出结构化结果 | 创建 Agents、修改 template、跨项目读取未授权上下文 |
| Worker | 执行一次性代码/实验/检索/评测任务，完成后返回结构化结果 | 持有长期 memory、承担团队协调角色 |

Research team 可以包含 `manager -> planner/coder/experiment/reviewer` 循环。manager 的价值是把 PM 从内部协调中释放出来，但 manager 不能继承 PM 的高权限。

## Shared Rules

Bots、Agents 和 Workers 需要共享 rules，但 rules 不能只散落在 prompt 或数据库里。目标是用 versioned RuleSet 编译出每次运行的 Rules Context Pack。

推荐层级：

1. System/runtime safety rules：不可由用户配置覆盖。
2. Org/global rules：所有 Bot、Agent、Worker 共享，例如“改完代码后同步更新说明文档和对应 MetaMemory，并报告未完成项”。
3. Bot-level rules：某个 Bot 的入口职责、权限和默认行为。
4. Team template rules：某个 template 的流程、质量门禁、memory policy、shared skills。
5. Team instance / project rules：当前聊天/项目的约定，包括本地 `AGENTS.md`、`CLAUDE.md`、数据路径和实验约定。
6. Agent role rules：planner/coder/experiment/reviewer/manager 的职责边界。
7. Worker rules：所有 worker 的执行要求，以及可选的 worker label rules，例如 `worker:nightly`。
8. Task/message rules：当前任务的临时要求。

合并规则：

- 每条 rule 带来源、版本、scope、是否可覆盖、适用对象和更新时间。
- 更具体的 rule 可以覆盖默认值，但不能覆盖不可覆盖的安全/权限规则。
- 编译后的 Rules Context Pack 必须带 provenance，方便排查“为什么这个 Agent 收到了这条规则”。
- Template 和 RuleSet 都按版本和 digest pin；已有 instance 不自动跟随 `latest`。
- Project instance 可以通过 promotion proposal 提出 rule/template patch。PM、用户、admin、manager 和 agent 可以创建 proposal；worker 只能把候选变更回报给 agent/manager 或 PM，不能直接创建 proposal。只有 PM、用户或 admin 可以 approve/reject。批准后才写入新的 template 或 RuleSet 版本；已有 instance 继续保持 pinned，除非显式迁移。
- MetaMemory 记录设计决策、候选规则和审批结论，但不应成为唯一 runtime source；template/rules 需要支持 export/import，便于维护和审查。

代码开发类 Bot/Agent/Worker 的默认全局 rule 应至少包含：

```text
如果改动代码或配置，必须同步检查是否需要更新说明文档和对应 MetaMemory。
如果没有更新，最终汇报要说明原因。
如果测试没有运行或失败，最终汇报要明确说明。
```

## 实施计划

当前实现状态：

- 已实现：从 `bots.json` bootstrap 的 versioned template store、template digest、chat/project/global instance resolver、legacy/runtime team metadata pinning、Agent/Task/Message/Run rows 的物理 `instance_id` 列和 backfill/sync、runtime team 的 instance-scoped Agent supervisor chat/session ID、重启恢复时清理内部 `worker-`、`team:`、`teaminst:` active-task 记录、runtime instance 的 RuleSet refs pinning、`instances resolve` 时显式追加并 pin RuleSet refs、team config 对 pinned RuleSet refs / quotas / `pmBot` 的显式更新、versioned RuleSet store、RuleSet export/diff/import 控制面、promotion proposal 及 PM/user/admin 审批、first-class `agent-role` / `worker` RuleSet 选择、Rules Context Pack 生成、Bot turn、Agent Team run、Worker dispatch prompt 的 Rules Context Pack 注入、只允许 PM/admin/user 执行 team 生命周期、Agent 创建/停止/删除、run stop、worker dispatch、服务重启和 template/rule promotion 的权限门禁、Agent、temporary Agent、scoped team count、queue backlog、active runs 的 quota enforcement、temporary Agent TTL 回收，以及现有 team 路由的 `instanceId` 查找。
- 已实现 CLI/API：`metabot teams templates ...`、`metabot teams proposals ...`、`metabot teams instances ...`、`metabot teams rules ...`，其中 `rules export/diff/import` 已补齐。现有 `<team>` 命令位置可以传 team name，也可以传 `instanceId`；chat/project scoped instance 建议优先传 `instanceId`。
- 已实现最小 activity-card lifecycle：`CardState.lifecycleStage` / `lifecycleKey`、飞书 v1/v2 卡片对非 closed 阶段的渲染、MessageBridge 对 `received`、`executing`、`recovering`、`blocked`、`closed` 的归一化，普通聊天、continuation、bytheway、spontaneous activity、direct Agent activity card、scheduled task、worker、Agent Team run 和 API task 主要路径上的稳定 lifecycle key 生成/透传，以及按 `lifecycleKey` 落盘的轻量 `SESSION_STORE_DIR/card-lifecycle.json` store。Agent Team activity card 在可用时会持久化 `teamName`、`instanceId`、`agentName`、`runId`、`taskIds` metadata，并可通过 `GET /api/agent-teams/<team>/activity` 与 `metabot teams activity <team>` 查询过滤后的历史。
- 已实现重启去重增量：restart recovery 给 continuation scheduled task 写稳定的 chat-scoped `dedupeKey`（`botName + chatId`），`TaskScheduler` 遇到相同 key 的 pending/executing task 会复用，不再重复排队；Worker dispatch 支持显式 `dedupeKey`，同一 `pmChatId + dedupeKey` 会复用 running 或近期 completed worker；final card delivery 会在 lifecycle record 上写 `finalDeliveredAt` / `finalDeliveryStatus` marker，避免同一 lifecycleKey 重复投递 final。
- 已实现重启恢复加固：bridge 启动时即使没有 fresh controlled-restart breadcrumb，只要还存在未过期的 active chat/API task record，也会把被打断卡片标为 `recovering` 并排 recovery continuation，而不是显示 `Task interrupted by service restart`。
- 已实现重启前 preflight guard、checkpoint handshake 和 bounded ready timeout：普通 `/restart service` 会检查记录中的活跃 bot/agent turn；如果还有其他工作在运行，会阻止服务重启。blocked/scheduled/forced/timed_out restart request 会记录到 `SESSION_STORE_DIR/restart-requests.json`；被阻塞的聊天会收到带同一个 `requestId` 的 restart-prepare 通知，可以回复 `/restart ready <requestId> [checkpoint note]`；发起方再次执行 `/restart service` 时会复用该 request，等当前 blockers 都 ready 后再安排重启。blocked request 默认有 10 分钟 ready timeout（可用 `METABOT_RESTART_READY_TIMEOUT_MS` 配置）；timeout 只会把 request 标成 `timed_out`，不会自动强制重启。`/restart service --force <reason>` 是显式覆盖路径。同聊天 scheduled restart 会保留 active-task record，让 restart recovery 可以排 continuation，而不是丢掉被中断的 turn。
- 已实现 config/authority 加固：`loadAppConfig()` 会保留 `bots.json` 中已受支持的 Agent Team template 字段（`quotas`、`ruleSetRefs`、`pmBot`、scoped instance metadata、temporary Agent lifecycle metadata），HTTP/CLI surface 在 team 生命周期、创建/停止/删除 Agent、停止 run、批准 promotion、直接 import template/rules、resolve instance、更新 team config 时也不再把缺失的 `actorRole` 当作 PM 权限。Worker dispatch/abort/redirect API 和 MCP 也要求显式 PM/user/admin `actorRole` / `actor_role`；受控服务重启会拒绝 manager/agent/worker actor role。
- 已实现 Web UI activity history：Team tab 会拉取 Agent Team 实例列表，并通过 `GET /api/agent-teams/<team>/activity` 展示 Agent Team lifecycle activity；选择具体 sub-agent 时按 `agentName` 过滤，同时保留原 bot task activity。
- 已实现 UI lease/checkpoint 增量：`card-lifecycle.json` 记录现在包含 `leaseOwner`、`leaseExpiresAt`、`checkpointNote`、`checkpointBy`、`checkpointAt`、`restartRequestId`；非终态 card 自动刷新 lease，closed card 自动释放 lease。`/restart ready <requestId> [checkpoint note]` 会把 blocker 的 checkpoint 写回对应 lifecycle record。
- 已实现 post-restart readiness report：受控重启后 recovery 会向 requester 和 blocker chats 汇报 requestId、状态、ready 进度、是否 timed out、queued continuations 和受影响 chats，并用 `reportedAt` 去重。
- 已实现原子重启执行：restart request 会经过 `scheduled/forced -> restarting -> healthy/failed`，同一 `requestId` 只能认领一次 PM2 操作；旧 bridge 只提交一次同 runtime 的 `pm2 restart --update-env`，新 bridge 负责健康检查与 `pm2 save`。MetaBot 进程树内禁止切换 runtime/worktree，必须由外部 `metabot deploy-runtime` 执行。
- 仍待实现：把主协调 key 从 legacy `teamName` surface 全量切到 `instanceId`，以及更完整的业务语义级 instance/run/message dedupe 审计视图。

Phase 1：数据模型和解析器

- 新增 template store：`templateId`、`version`、`digest`、`agents`、`sharedPrompts`、`skills`、`workflowPolicy`、`qualityGates`、`ruleSetRefs`。
- 新增 instance store：`instanceId`、`templateId`、`templateVersion`、`scopeType`、`scopeKey`、`chatId`、`projectId`、`pmBot`、`status`、`quotas`。
- 将 tasks/messages/runs/session/chat/activity card 从 `teamName` 迁移到 `instanceId`。
- 新增 resolver：`resolveTeam(templateName, chatId, projectId, createIfMissing)`。

Phase 2：template bootstrap 和 export/import

- `bots.json` 只作为 bootstrap/template seed。
- 启动时把 `agentTeams` 导入 versioned template store，内容变化生成新版本。
- 支持 `metabot teams templates export/import/diff`.
- 不在运行时 instance 中保存 secrets，只保存引用。

Phase 3：权限、配额和回收

- 为 PM、manager、Agent、Worker 定义 capability policy。
- 限制每个 chat/project 的 team 数、Agent 数、temporary Agent 数、active runs、队列长度和 idle TTL。team 数、Agent 数、temporary Agent 数、active runs 和队列长度已实现；idle TTL 已覆盖 temporary Agents。
- 临时 Agent 过期后归档或停止；有任务的 Agent 先 stop/requeue，再回收。
- manager 只能请求 PM 创建 Agent、派 Worker 或重启服务，不能直接执行高权限操作。

默认 quota 字段：

| 字段 | 默认值 | 含义 |
| --- | ---: | --- |
| `maxAgents` | 8 | 每个 team instance 的 active Agents |
| `maxTemporaryAgents` | 3 | 每个 team instance 的 temporary Agents |
| `maxParallelRunsPerAgent` | 4 | 每个 Agent 的并发 runs |
| `maxTeamsPerScope` | 3 | 每个 chat/project/global scope 的 active team instances |
| `maxQueuedTasks` | 64 | 每个 team instance 的 pending / in-progress tasks |
| `maxActiveRuns` | 16 | 每个 team instance 的 running runs |

Phase 4：shared rules 编译

- 建立 RuleSet store，支持版本、digest、scope、export/import。
- 在 Bot turn、Agent run、Worker dispatch 前编译 Rules Context Pack。Bot turn 会收到 global/bot/task rules，Agent Team run 会收到 global/team/role/task rules，Worker dispatch 会收到 global/bot/worker/task rules。
- 记录 rules load log 和冲突处理结果，便于审计。

Phase 5：activity card 和恢复

- `displayChatIds` 移到 instance。
- 卡片状态改为 bounded state machine：received、acknowledged、executing、checkpointing、responding、closed、recovering、blocked。当前 bridge 已有 lifecycle 字段、飞书渲染、主要 card/task 路径上的 lifecycle key、轻量 JSON lifecycle store、lease/checkpoint 字段，以及 Web UI/API/CLI activity history。Agent Team activity record 在可用时会带 instance/run/task metadata；restart readiness ACK 会把 checkpoint note 写入对应 lifecycle record。
- 普通服务重启前，如果记录中还有其他活跃 turn，则先阻止重启，并把 blocker snapshot 记录到 restart `requestId` 下。被阻塞的聊天会收到 restart-prepare 通知和 checkpoint 命令；等 blockers 确认 ready 后，发起方重试 `/restart service` 即可继续同一 request。
- `/restart status` 会展示最近持久化的 restart request 和第一条 blocker，运维者可以直接在飞书里查看 blocked restart，不必读日志或 JSON 文件。
- 被阻止的参与者可以用 `/restart ready <requestId> [checkpoint note]` 确认已经准备好；ACK 会持久化到 restart request，`/restart status` 会显示 `ready=x/y` 进度。重试时会复用同一个 blocked request，不会丢失 readiness。
- blocked restart request 有有界 ready timeout。超时后 request 会被标为 `timed_out`，`/restart status` 会显示 timeout 状态；MetaBot 会要求发起方等待 blockers 完成后重试，或用 `/restart service --force <reason>` 做显式紧急覆盖。
- 重启完成后，restart recovery 会向 requester 和 blocker chats 发送 post-restart readiness report；每个 request 只报告一次。
- 如果 bridge 是从非受控路径重启，但仍能找到最近的 active task record，restart recovery 现在会排一个带有“没有 fresh controlled-restart breadcrumb”说明的 continuation，而不是把卡片置为 failed 并要求用户重发。
- 重启恢复时基于 instance/run/message dedupe key，避免重复派发 worker 或重复最终回复。restart-continuation scheduler 路径已有稳定 dedupe key；Worker dispatch 已支持调用方显式传 `dedupeKey` 复用 running/近期 completed worker；final delivery 已通过 lifecycle delivery marker 避免同一 lifecycleKey 重复 final。后续需要把这些 key 和审计视图统一到 first-class `instanceId` / run / message 模型上。

## CLI 工作流

所有协调都使用 `metabot teams`：

```bash
metabot teams create metabot-dev --description "MetaBot implementation team" --actor-role pm
metabot teams agents spawn metabot-dev cli-engineer --role implementation --actor-role pm --engine codex --prompt "Own CLI UX, tests, and docs."
metabot teams tasks create metabot-dev "Add runs CLI" --description "Expose runs create/update in bash and TS CLIs." --owner cli-engineer
metabot teams send metabot-dev cli-engineer "Start task 4." --from lead --summary "assign task 4"
```

对于 scoped runtime team，先运行 `metabot teams instances resolve <template> --chat <chatId> --rule-ref <name[@version]> --actor-role pm`，或查看 `metabot teams instances list`。返回的 `instanceId` 可以用在命令参考中所有 `<team>` 位置，例如 `metabot teams tasks list ati_...`。

如果项目创建后还要追加新的 pinned 约定，用 `metabot teams config <instanceId> --rule-ref <name[@version]> --pm-bot <name> --actor-role pm`；需要时也可以一起传 `--max-temporary-agents 5` 这类 quota 参数。这样更新的是当前 runtime instance，不会偷偷跟随 `latest`。

Agent 每一轮通常先读取邮箱和任务：

```bash
metabot teams inbox metabot-dev cli-engineer --unread --read
metabot teams tasks get metabot-dev 4
metabot teams tasks update metabot-dev 4 --status in_progress --owner cli-engineer
```

完成后写入结果并通知 lead：

```bash
metabot teams tasks update metabot-dev 4 --status completed --result "Added runs create/update to bash and TS CLI; production smoke passed."
metabot teams send metabot-dev lead "Completed task 4: runs create/update is live." --from cli-engineer --summary "task 4 complete"
```

## Runs

Runs 表示 Agent 的后台执行记录。Supervisor 和飞书卡片快照都会用它展示进行中或已完成的后台工作。

```bash
metabot teams runs list metabot-dev
metabot teams runs create metabot-dev --agent cli-engineer --task-id 4 --status running --output "Starting smoke test"
metabot teams runs update metabot-dev <runId> --status completed --output "Smoke passed"
metabot teams runs output metabot-dev <runId>
metabot teams runs stop metabot-dev <runId> --actor-role pm
```

合法 run 状态包括 `running`、`completed`、`failed` 和 `stopped`。`metabot teams runs stop` 现在会在可用时走 supervisor：把 run 标记为 `stopped`，请求 bridge 停止该 Agent chat task，把已分配且 in-progress 的任务重新排回 `pending` 并写入 stop 说明，同时抑制迟到的 executor output，避免延迟返回的成功结果覆盖 stopped run。

失败 run 的处理：

- 手动 CLI 使用者应在失败时设置 `--status failed --error "<reason>"`。
- Background activity 面板会展示 failed run，并在有 error 时展示错误内容。
- `metabot teams runs output <team> <runId>` 会返回 `output` 和 `error`，lead 不需要直接查数据库即可查看失败原因。
- Supervisor 会把崩溃或执行不成功的 run 标记为 `failed`，保存 error 字符串，把已分配且 in-progress 的任务重新排回 `pending` 并在 `result` 写入失败上下文，把 agent 恢复为 idle，并由非 lead Agent 给 `lead` 发失败消息。下一次 supervisor tick 可以再次拾取该任务；lead 负责决定是否允许重试、转派或停止团队。

## 卡片展示

Bridge 会从 Agent Teams store 构建团队快照：

- **Team** 面板刻意保持紧凑。若有 agent 在工作，会显示 `⏳ 2/4 working` 这样的计数，并为每个 working agent 展示一行简短活动（最多两行，之后显示 `+N more working`）；idle agent 不再逐个列出。若没有任何 agent 在工作，整个面板会折叠成单行 `💤 idle (4 agents)`；如果还有未完成工作，则会追加任务总数和最多两个 open task 主题。
- 较长的 team id 会按展示用途缩短，例如 `research-codex@chat:oc_abc…` 会显示为 `research-codex`。
- **Background activity** 面板展示 runs、状态以及最新 output 或 error。
- 卡片展示的任务状态包括 `pending`、`in_progress` 和 `completed`；`deleted` 任务会隐藏。

这些卡片状态来自 `/api/agent-teams/<team>` 数据，因此 CLI 更新会立即影响 bridge 可渲染的内容。

卡片按 chat 绑定展示。只有当前 chat 命中团队的 `displayChatIds` 或 `chatIds` 时，该团队才会显示；active teams 不会全局出现在所有飞书会话里。`team:metabot-dev:cli-engineer` 这类 Agent 执行会话可放在 `chatIds`，面向用户的飞书会话应放在 `displayChatIds`。

## Supervisor 阶段

Agent Team supervisor 是 bridge 侧循环。启用后，它扫描 active teams，找到有未读消息或已分配 pending 任务的 agents，创建 run，标记 agent 为 working，并在该 agent 的独立会话中执行。Run 结束后，它记录 output 或 error，并给 lead 发消息。

运行细节：

- 用 `METABOT_AGENT_TEAM_SUPERVISOR=0` 关闭循环。
- 用 `METABOT_AGENT_TEAM_SUPERVISOR_INTERVAL_MS` 调整轮询间隔。
- 在 `bots.json` 设置 `agentTeamExecutionBot`，或用 `METABOT_AGENT_TEAM_EXECUTION_BOT` 固定由哪个 bridge bot 执行 Agent run。建议使用非特权 PM/内部 worker bot，例如 `research-pm`；当 `manager` 是第一个注册 bot 时，不要依赖注册顺序。
- 如果团队实例带有 `pmBot`（例如 PM 创建的 chat/project 作用域运行时实例），且该 bot 已注册，则该实例会优先通过自己的 `pmBot` 执行，优先级高于全局 `agentTeamExecutionBot`。这样 `pm-claude` 拥有的实例无需改全局配置也会继续跑在 `pm-claude` 上；该团队的活动卡片也会复用同一个 bot。
- 没有可用的 `pmBot`、也没有显式 execution bot 时，Supervisor 依次回退到 `metabot`、`research-pm`、第一个非 `manager` bot、最后才是第一个已注册 bot。
- Supervisor 启动 run 时，会把已分配的 pending 任务改为 `in_progress`。
- Supervisor 会为 Agent chat 设置配置的 session engine，但目前还不会在派发前校验每个引擎的能力。在 runtime capability checks 或 per-engine adapters 落地前，常驻团队应使用本地 bridge 已知可工作的引擎。

## `bots.json` 中的常驻团队

下面描述的是当前实现。目标模型会把这里的 `agentTeams` 作为 template seed 导入 versioned template store，而不是继续作为全局运行态。

CLI-only 设置适合临时团队。常驻团队在 `bots.json` 的 `agentTeams` 下声明，bridge 启动时会把它们 reconcile 到团队 store。启用热加载时，修改 `bots.json` 会自动 reconcile；设置 `METABOT_AGENT_TEAMS_HOT_RELOAD=0` 可关闭 watcher。

```json
{
  "feishuBots": [
    { "name": "metabot", "engine": "codex", "feishu": { "appId": "...", "appSecret": "..." } }
  ],
  "agentTeamExecutionBot": "metabot",
  "agentTeams": [
    {
      "name": "metabot-dev",
      "description": "MetaBot implementation team",
      "status": "active",
      "chatIds": ["team:metabot-dev:cli-engineer", "team:metabot-dev:runtime-engineer"],
      "displayChatIds": ["oc_feishu_chat_id"],
      "agents": [
        { "name": "cli-engineer", "role": "implementation", "engine": "codex", "prompt": "Own teams CLI, command UX, tests, and docs." },
        { "name": "runtime-engineer", "role": "runtime", "engine": "codex", "prompt": "Own bridge runtime, store, supervisor, and cards." }
      ],
      "tasks": [
        { "id": 8, "subject": "Document Agent Teams workflow", "owner": "cli-engineer", "status": "pending" }
      ]
    }
  ]
}
```

`lead` 不是全局保留名。对于 `metabot-dev` 这样的顶层团队，当前面向用户的 bot
就是 leader，因此不需要额外创建一个顶层 `lead` member。没有 active `lead`
member 时，发给 `lead` 的消息会被当成 leader activity，并通过面向用户的 Agent
Activity card 推出来。嵌套 team 或子项目仍然可以定义独立的 `lead` member；这种情况下
`team:<team>:lead` 会像其他 member session 一样运行。

Reconcile 行为：

- 已配置团队按 name 创建或更新。
- 已配置 agents 和 tasks 会 upsert。
- 如果某个已配置团队移除了 agents，且仍至少列出一个期望 agent，缺失的既有 agents 会标记为 `stopped`。
- 曾经出现在 `agentTeams` 中的团队会标记为 `managedByConfig`；后续如果从配置中移除，reconcile 会把它标记为 `stopped`。
- 手动 CLI 创建的团队会保留，除非它和已配置团队同名。

既有数据库的 rollout 注意事项：`managed_by_config` 列添加到既有 Agent Teams DB 时默认是 false。之前已经存在的 resident/config-created teams 只有在 bridge 从 `bots.json` reconcile 过一次后，才会被视为配置托管。部署这个变更后，请在保留期望 `bots.json` `agentTeams` 的情况下重启 bridge，或触发一次热加载。只有完成这次 reconcile 后，才应依赖“从 `agentTeams` 移除团队”作为 rollback 机制来停止旧 resident team。

## 命令参考

```bash
metabot teams list
metabot teams create <team> [--description <text>] [--actor-role admin|user|pm]
metabot teams delete <team> [--actor-role admin|user|pm]
metabot teams status <team>
metabot teams start <team> [--actor-role admin|user|pm]
metabot teams stop <team> [--actor-role admin|user|pm]

metabot teams agents list <team>
metabot teams agents spawn <team> <name> [--role <agent-role>] [--actor-role admin|user|pm] [--engine claude|codex|kimi] [--prompt <text>]
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

## 当前限制

- Agent Teams 是本地 bridge 状态，不是 metabot-core 状态。请在 bridge 主机上使用，或配置 `METABOT_URL` 和 `API_SECRET` 后远程访问。
- 引擎中立指协调模型中立，不代表所有引擎都天然支持所有执行能力。Agent 引擎选择仍走当前 bridge/session-engine 边界。
- Supervisor 可以执行 Agent，但 lead 仍然负责整合质量和最终用户汇报。
- `runs stop` 会通过 bridge supervisor 请求取消并重新排队已分配任务，但实际取消仍取决于当前引擎任务是否响应 bridge stop signal。
- Runs 存储文本 output 和 error；大型产物仍应走常规输出文件路径。

## 相关

- [metabot CLI](../reference/cli-metabot.zh.md) — 完整 CLI 参考
- [MetaSkill](metaskill.md) — 先生成团队 prompts 和 skills，再运行
- [目标循环](goal-loops.md) — 给团队一个更长周期的目标
- [Peers 联邦](peers.md) — 跨 MetaBot 实例路由工作
