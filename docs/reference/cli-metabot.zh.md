# metabot CLI

`metabot` 是 MetaBot 唯一的 CLI 入口，包含三类命令：

1. **bridge 进程控制** —— 管理本地 MetaBot 服务生命周期。
2. **bridge 守护进程 API** —— curl 本地 bridge 守护进程（`localhost:9100`）。
3. **metabot-core 转发** —— 转发给中心功能 CLI。

## 安装

MetaBot 安装器自动安装到 `~/.local/bin/metabot`。

> 旧的 `mb` / `mm` / `mh` CLI 已下线。安装与更新会主动删除 `~/.local/bin/`
> 里的残留二进制；如果脚本里还有这些命令，会报 `command not found`，请
> 改成 `metabot <子命令>`。

## 1. bridge 进程控制

```bash
metabot update                      # 内网 package refresh，重新构建，更新 skills，重启
metabot update --git                # 开发者专用：git pull + 构建 + 重启
metabot start                       # 启动（PM2）
metabot stop                        # 停止
metabot restart                     # 重启
metabot logs                        # 查看实时日志（可传 -n 100 等）
metabot status                      # PM2 进程状态
```

`metabot update` 是推荐的更新方式。它依次执行：

1. 从 `METABOT_CORE_URL/install/latest.tgz` 下载当前内网安装包
2. 覆盖代码文件，保留 `.env`、`bots.json`、`logs/`、`data/` 和 `.git/`
3. `npm install && npm run build` — 重新构建
4. 复制 MetaBot 内置 skills 到 Claude/Codex skill 目录
5. 如果本机已安装 `lark-cli` 或 lark skills，自动更新 `@larksuite/cli` 并刷新 lark AI Agent skills
6. 同步 skills 到已配置的 bot 工作目录
7. `pm2 restart` — 重启服务

一条命令搞定。源码 checkout 仍可使用 `metabot update --git`，但这是开发者路径，需要干净的 Git remote。

## 2. bridge 守护进程 API

这些命令 curl 本地 bridge 守护进程（`localhost:9100`），从 bridge `.env` 读取
`API_PORT` / `API_SECRET`（以及可选的 `METABOT_URL`）。

### Bot 管理

```bash
metabot bots                        # 列出所有 Bot（本地 + peer）
metabot bot <name>                  # 获取 Bot 详情
```

### Agent 对话

```bash
metabot talk [--async|--sync] [--no-cards] [--wait-ms N] <bot> <chatId> <prompt>      # 与 Bot 对话（bridge /api/talk）
metabot talk-status <taskId>        # 用本机认证查询 async talk 任务状态
metabot talk alice/bot <chatId> <prompt>  # 指定 peer 的 Bot 对话
```

Bot 名称支持[限定名](../features/peers.md#限定名)（`peerName/botName`）实现跨实例
路由。这是 bridge 本地的对话路径；`metabot agents talk` 是基于中心注册表的 P2P
变体。
`metabot talk` 默认最多等待 25 秒；如果任务没完成，会返回 `taskId` 和
`statusCommand`，避免本地测试员一直卡在同步等待。需要旧的阻塞行为时使用
`--sync`；需要立即后台执行时使用 `--async`。Async talk 响应会同时返回给 API
客户端用的 `statusUrl`，以及给本机 CLI 用户用的 `statusCommand`，例如
`metabot talk-status <taskId>`。
Async task 状态会持久化到 `SESSION_STORE_DIR`；如果 bridge 在任务运行中重启，
旧 taskId 应返回 `failed` 和 `task_interrupted_by_restart`，而不是直接变成
`Task not found`。

### Peers

```bash
metabot peers                       # 列出 peer 及状态
```

### Agent 团队

`metabot teams` 调用本地 bridge 的 `/api/agent-teams/*` API。它是 MetaBot Agent 团队的协调入口，覆盖 agents、邮箱消息、共享任务和后台 runs。

```bash
metabot teams list
metabot teams create <team> [--description <text>] [--actor-role admin|user|pm]
metabot teams status <team>
metabot teams bind <team> <chatId> [--display] [--actor-role admin|user|pm]
metabot teams start <team> [--actor-role admin|user|pm]
metabot teams stop <team> [--actor-role admin|user|pm]
metabot teams delete <team> [--actor-role admin|user|pm]

metabot teams config <team> [--chat <id,id>] [--display-chat <id,id>] [--pm-bot <name>] [--rule-ref <name[@version],...>] [--max-agents <n>] [--max-temporary-agents <n>] [--max-parallel-runs <n>] [--max-teams-per-scope <n>] [--max-queued-tasks <n>] [--max-active-runs <n>] [--actor-role admin|user|pm]
metabot teams activity <team> [--agent <name>] [--run-id <id>] [--task-id <id>] [--chat <chatId>] [--source <name>] [--limit <n>] [--summary|--plain]
metabot teams templates list [name]
metabot teams templates export <name> [--version <n>]
metabot teams templates diff <name> --from <n> [--to <n>]
metabot teams templates import '<json>' [--source <name>] [--actor-role admin|user|pm]
metabot teams proposals list [--status pending|approved|rejected]
metabot teams proposals create [template|ruleset] '<json>' [--summary <text>] [--by <name>] [--role admin|user|pm|manager|agent]
metabot teams proposals approve <id> [--by <name>] [--actor-role admin|user|pm] [--reason <text>]
metabot teams proposals reject <id> [--by <name>] [--actor-role admin|user|pm] [--reason <text>]
metabot teams instances list [--template <name>]
metabot teams instances resolve <template> [--chat <chatId>|--project <projectId>|--global] [--pm-bot <name>] [--rule-ref <name[@version]>] [--actor-role admin|user|pm]
metabot teams rules list [name]
metabot teams rules export <name> [--version <n>]
metabot teams rules diff <name> --from <n> [--to <n>]
metabot teams rules import '<json>' [--source <name>] [--actor-role admin|user|pm]
metabot teams rules set <name> --scope global|bot|team-template|team-instance|project|agent-role|worker|task --rule <text> [--actor-role admin|user|pm]
metabot teams rules context --ref <name[@version]> [--rule <text>]

metabot teams config <team> [--chat <id,id>] [--display-chat <id,id>] [--pm-bot <name>] [--rule-ref <name[@version],...>] [--max-agents <n>] [--max-temporary-agents <n>] [--max-parallel-runs <n>] [--max-teams-per-scope <n>] [--max-queued-tasks <n>] [--max-active-runs <n>] [--actor-role admin|user|pm]
metabot teams config <team> [--chat <id,id>] [--display-chat <id,id>] [--pm-bot <name>] [--rule-ref <name[@version],...>] [--max-agents <n>] [--max-temporary-agents <n>] [--max-parallel-runs <n>] [--max-teams-per-scope <n>] [--max-queued-tasks <n>] [--max-active-runs <n>] [--actor-role admin|user|pm]
metabot teams activity <team> [--agent <name>] [--run-id <id>] [--task-id <id>] [--chat <chatId>] [--source <name>] [--limit <n>] [--summary|--plain]
metabot teams templates list [name]
metabot teams templates export <name> [--version <n>]
metabot teams templates diff <name> --from <n> [--to <n>]
metabot teams templates import '<json>' [--source <name>] [--actor-role admin|user|pm]
metabot teams proposals list [--status pending|approved|rejected]
metabot teams proposals create [template|ruleset] '<json>' [--summary <text>] [--by <name>] [--role admin|user|pm|manager|agent]
metabot teams proposals approve <id> [--by <name>] [--actor-role admin|user|pm] [--reason <text>]
metabot teams proposals reject <id> [--by <name>] [--actor-role admin|user|pm] [--reason <text>]
metabot teams instances list [--template <name>]
metabot teams instances resolve <template> [--chat <chatId>|--project <projectId>|--global] [--pm-bot <name>] [--rule-ref <name[@version]>] [--actor-role admin|user|pm]
metabot teams rules list [name]
metabot teams rules export <name> [--version <n>]
metabot teams rules diff <name> --from <n> [--to <n>]
metabot teams rules import '<json>' [--source <name>] [--actor-role admin|user|pm]
metabot teams rules set <name> --scope global|bot|team-template|team-instance|project|agent-role|worker|task --rule <text> [--actor-role admin|user|pm]
metabot teams rules context --ref <name[@version]> [--rule <text>]

metabot teams agents list <team>
metabot teams agents spawn <team> <name> [--role <agent-role>] [--actor-role admin|user|pm] [--engine claude|codex|kimi] [--model <model>] [--reasoning-effort <level>] [--approval-policy <policy>] [--sandbox <mode>] [--timeout-ms <n>] [--idle-timeout-ms <n>] [--allowed-tools <a,b>] [--prompt <text>]
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

`runs stop` 会把 run 标记为 `stopped`；当该 in-flight run 由 bridge supervisor 管理时，还会请求 bridge 停止对应 Agent chat task，把已分配且 in-progress 的任务重新排回 `pending`，并抑制该 stopped run 的迟到 executor output。

Template/rule 命令是 Phase 1 控制面，用于 versioned Agent Team template、chat/project scoped runtime instance、pinned RuleSet refs、versioned RuleSet 和 promotion proposal。manager 或 agent 可以创建 proposal，但只有 PM、用户或 admin 可以 approve/reject；批准后写入新的 template 或 RuleSet 版本，并且不会自动升级已 pinned 的 instance。`instances resolve --rule-ref ...` 用于在创建时 pin 额外的 project/runtime RuleSet，`teams config ... --rule-ref ...` 用于显式更新当前 instance，`rules export/diff/import` 则让 RuleSet 具备和 template 对称的审查与迁移流程。现有 `<team>` 参数可以传 team name，也可以传 `instanceId`；chat/project scoped team 建议优先使用 `instances resolve` 返回的 `instanceId`。底层存储 schema 仍以 `teamName` 保存行，runtime 会继续逐步迁移到 first-class `instanceId`。

对于有权限影响的 CLI 操作，`--actor-role` 表示调用者权限身份（`admin`、`user` 或 `pm`）。team 生命周期变更、绑定/config 更新、直接创建或停止/删除 Agent、停止 run、直接 import/set template 或 rules、resolve instance、批准/拒绝 proposal 都需要显式传入。`agents spawn` 的 `--role` 是被创建 Agent 的职责标签，不是权限身份。

同一套命令同时实现在 `bin/metabot` 和 `packages/cli` 的 TypeScript 功能 CLI 中。Bridge 从 `.env` 读取 `API_PORT` / `API_SECRET` 和可选的 `METABOT_URL`。

### 定时任务

```bash
metabot schedule list                                          # 列出全部
metabot schedule cron <bot> <chatId> '<cron>' <prompt>         # 创建周期性任务
metabot schedule add <bot> <chatId> <delaySec> <prompt>        # 创建一次性任务
metabot schedule pause <id>                                    # 暂停
metabot schedule resume <id>                                   # 恢复
metabot schedule cancel <id>                                   # 取消
```

### 统计、指标与健康

```bash
metabot stats                       # 费用与使用统计
metabot metrics                     # Prometheus 指标
metabot health                      # 健康检查
```

### 语音

```bash
metabot voice call <bot> <chatId> [prompt] [-w opening]  # 发起 RTC 语音通话
metabot voice transcript <sessionId>                     # 获取通话转录
metabot voice list                                       # 列出活跃语音会话
metabot voice config                                     # 检查 RTC 配置
metabot voice tts "你好世界"                              # 生成 MP3，输出文件路径
metabot voice tts "你好" --play                           # 生成并播放音频
metabot voice tts "你好" -o greeting.mp3                  # 保存到指定文件
echo "长文本" | metabot voice tts                         # 从标准输入读取
metabot voice tts "你好" --provider doubao                # 指定 TTS 服务商
metabot voice tts "你好" --voice nova                     # 指定声音
```

TTS 参数：

| 参数 | 说明 |
|------|------|
| `--play` | 生成后播放（macOS: afplay, Linux: mpv/ffplay/play） |
| `-o FILE` | 保存到指定文件（默认: `/tmp/metabot-voice-<时间戳>.mp3`） |
| `--provider NAME` | TTS 服务商: `doubao`、`openai`、`elevenlabs` |
| `--voice ID` | 声音/音色 ID（各服务商不同） |

## 3. metabot-core 转发

上面未列出的任何子命令都会转发给 metabot-core 功能 CLI
（`packages/cli/bin/metabot`）：

```bash
metabot t5t board                   # 团队日报看板
metabot agents list                 # 对端 Bot 通讯录
metabot memory search "<query>"     # 共享记忆全文搜索
metabot skills list                 # 中心 Skill Hub
```

未在环境中导出时，`METABOT_CORE_URL` / `METABOT_CORE_TOKEN` 从 bridge `.env`
读取。用 `export METABOT_CORE_CLI=/path/to/packages/cli/bin/metabot` 覆盖
CLI 路径。

## 远程访问

默认 bridge 守护进程 API 连接 `http://localhost:9100`。配置远程访问：

```bash
# 在 ~/.metabot/.env 或 ~/metabot/.env 中
METABOT_URL=http://your-server:9100
API_SECRET=your-secret
```
