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
metabot update                                  # Package 安装：最新 GitHub Release
metabot update --package                        # 强制使用最新 GitHub Release 包
metabot update --package --version 1.3.0        # 固定不可变 Release v1.3.0
metabot update --git                            # 强制 git pull + 构建 + 重启
metabot start                       # 启动 Bridge、Worker Runner 与 ARC
metabot stop                        # 停止整套三个 PM2 应用
metabot restart                     # 多 Bot 协调式 Bridge 重启
metabot restart --bot admin --chat oc_x --reason "升级"  # 向指定会话回报
metabot restart --no-resume         # 只通知，不自动续接被中断任务
metabot restart --force             # 准备失败时的紧急显式覆盖
metabot restart --wait --json       # 受保护的 Bridge 单独重启
metabot restart --request-id ID     # 调用方提供的稳定去重键
metabot restart --force             # 会话准备失败时的紧急显式覆盖
metabot restart --daemon worker     # 有忙碌检查的 Worker Runner 重启
metabot restart --daemon arc        # 有忙碌检查的 ARC 重启
metabot deploy-runtime --runtime /absolute/checkout --wait  # 从外部安全切换整套运行目录
metabot logs                        # 查看实时日志（可传 -n 100 等）
metabot status                      # PM2 进程状态
```

普通 Package 管理的个人版执行 `metabot update` 时，默认升级到最新 GitHub
Release。源码 checkout 会被自动识别并保留 Git 更新路径；用 `--package`
可以强制进行 Release 覆盖。

`metabot update --package --version 1.3.0` 选择不可变 v1.3.0 资源而不是
`latest`。Package 更新依次执行：

1. 从最新或固定 GitHub Release 下载 `install.sh`、`metabot-runtime.tgz` 和 `SHA256SUMS`。
2. 解压前验证 runtime SHA256。
3. 校验完整个人版 Manifest 和语义版本；固定版本必须精确匹配。
4. 覆盖 `METABOT_HOME` 中的代码，保留 `.env`、`bots.json`、`logs/`、`data/` 和 `.git/`。
5. 保留 `~/.metabot/` 和 `~/.metabot-core/` 下的用户/Core 状态；只有 Package 管理的 `~/.metabot/default.env` 可能刷新。
6. 安装依赖并构建 Bridge、Core、Web UI 和委托 CLI。
7. 刷新内置/工作区 Skills，以及已有的 Lark CLI Skills。
8. 重启 Bridge 与两个执行守护进程，健康检查通过后再保存 PM2 状态。

普通 `restart` 支持 `--request-id`、`--bot`、`--chat`、`--source`、
`--reason`、`--resume`/`--no-resume`、`--wait`、`--timeout`、`--force` 和 `--json`。
`deploy-runtime` 还支持 `--wait`/`--no-wait` 与 `--force`。相同 request ID
再次提交时只读取已有的持久结果，不会重复执行 PM2 操作。

旧 Bridge 会原子写入 breadcrumb（用于告诉新进程这次重启的结构化小文件）和
SQLite 请求记录，然后只就地更换已注册的 `metabot` 进程。新 Bridge 依次验证
自身 HTTP 健康、两个执行守护进程的通信健康，以及 PM2 的运行目录、脚本、解释器、
解释器参数和环境；全部通过后才执行 `pm2 save --force` 并把请求标为健康。密钥、
代理等环境值只以 SHA-256 指纹写入重启台账，不保存明文。完成通知和恢复归属都持久化
之后才删除 breadcrumb，从而避免恢复后的会话再次重启。

在进入持久 PM2 切换前，已鉴权的本地 Bridge 会短暂暂停所有已注册 Bot 接收新任务，
并快照所有活跃 chat。每个受影响的用户 chat 都由自己的 Bot 发送 **Restart Preparing**
通知；任一通知失败都会取消重启并解除暂停，除非操作者明确传入 `--force`。准备状态还有
两分钟租约，控制器若在修改 PM2 前消失，Bridge 会自动恢复接收工作。
CLI 在带签名能力的引擎会话内运行时，只转发该会话的作用域能力，不暴露 Bridge 管理员
密钥。只有 `user`、`pm` 或 `admin` 角色可以为签名中完全一致的 Bot 与 chat 准备或取消
重启；Agent Team agent 和 Worker 仍会被拒绝。

带 `--resume` 时，启动流程会为每个被中断的用户 chat 创建可去重的持久续做任务，
而不再只恢复发起者；每个受影响 Bot 都会发送自己的 **Restart Complete** 通知。
调度器会先原子写盘，再启动计时器；如果写盘或完成通知失败，系统会保留 breadcrumb，
供下一次启动重试。无卡片的 Agent Bus 任务仍会恢复，但不会向虚拟 chat ID 发消息。Agent Team、Worker 和 ARC
内部 chat 不走通用恢复，而由各自的持久 supervisor 或守护进程负责。状态文件位于
`SESSION_STORE_DIR`、`METABOT_STATE_DIR` 或 `~/.metabot/` 下，文件名为
`restart-state.sqlite`、`controlled-restart.json` 和 `last-restart.json`。该功能不迁移
`sessions.db`。

守护进程有活跃工作时会拒绝重启。`--force` 明确接受状态不明的工作可能变为
`recovery_required`。`deploy-runtime` 使用相同检查，并且必须在 MetaBot 进程树之外执行。
它会先核对当前 Bridge PID 与调用者的父进程链；任一项无法读取时会拒绝切换，
不会把“无法判断”当成“确认来自外部”。
它会先校验目标配置和回退配置，再按 Worker Runner、ARC、可选的本地 Core、Bridge
顺序就地重启，不删除 PM2 条目；任何切换失败都会回退已经改变的应用。Core 仍使用
独立 ecosystem，只有当前 PM2 cwd 和脚本都精确属于 Bridge 运行目录时才会加入切换；
外部 Core 完全不动。`uninstall.sh` 使用相同的所有权检查。只有健康的新 Bridge 会保存
PM2 进程列表。

在线运行目录的包更新必须从 SSH 或其他位于 Bridge 进程树之外的控制器发起。
更新器会在下载前拒绝内部调用者或无法验证的调用者，然后使用带 request ID 的
无删除原地切换。首次安装或服务离线时可以创建缺失的 PM2 条目，但不会删除已有条目。

可用 `METABOT_UPDATE_INSTALLER_URL` 覆盖 Package 镜像地址。`--version` 只接受
`x.y.z`（可选前导 `v` 会被标准化），且不能与 `--git` 组合。

### 协调式重启

`metabot restart` 会先请求已鉴权的本地 Bridge 进入准备状态。Bridge 短暂停止接收新
工作，快照所有已注册 Bot 的活跃任务，并使用每个 Bot 自己的渠道身份向受影响会话
发送 **Restart Preparing** 卡片。如果任何受影响会话无法收到通知，重启会取消，
Bridge 也会恢复接收工作；`--force` 是明确的紧急覆盖开关。

PM2 启动新 Bridge 后，每个受影响 Bot 都会更新被中断的任务卡片、发送
**Restart Complete** 卡片，并且只排队一次续接任务。稳定的 `--request-id` 用于去重。
`--bot` 与 `--chat` 还能让没有活跃任务的发起会话收到结果；没有目标 chat ID 的空闲
Bot 不会收到无目的消息。

交接状态以原子写入方式保存在 `SESSION_STORE_DIR`（通常为 `~/.metabot/`）下的
`controlled-restart.json` 和 `last-restart.json`，不会修改 session 数据库。如果 PM2
拒绝重启，CLI 会先取消 Bridge 的准备状态并删除 breadcrumb，再返回错误。

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
metabot talk <bot> <chatId> <prompt>      # 与 Bot 对话（bridge /api/talk）
metabot talk alice/bot <chatId> <prompt>  # 指定 peer 的 Bot 对话
```

Bot 名称支持[限定名](../features/peers.md#qualified-names)（`peerName/botName`）实现跨实例
路由。这是 bridge 本地的对话路径；`metabot agents talk` 是基于中心注册表的 P2P
变体。

### Peers

```bash
metabot peers                       # 列出 peer 及状态
```

### Agent 团队

`metabot teams` 调用本地 bridge 的 `/api/agent-teams/*` API。它是 MetaBot Agent 团队的协调入口，覆盖 agents、邮箱消息、共享任务和后台 runs。

```bash
metabot teams list
metabot teams create <team> [--description <text>]
metabot teams status <team>
metabot teams start <team>
metabot teams stop <team>
metabot teams delete <team>

metabot teams agents list <team>
metabot teams agents spawn <team> <name> [--role <role>] [--engine claude|codex|kimi] [--prompt <text>]
metabot teams agents stop <team> <name>
metabot teams agents delete <team> <name>

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
metabot teams runs stop <team> <runId>
```

`runs stop` 会把 run 标记为 `stopped`；当该 in-flight run 由 bridge supervisor 管理时，还会请求 bridge 停止对应队友 chat task，把已分配且 in-progress 的任务重新排回 `pending`，并抑制该 stopped run 的迟到 executor output。

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

| 参数              | 说明                                                      |
| ----------------- | --------------------------------------------------------- |
| `--play`          | 生成后播放（macOS: afplay, Linux: mpv/ffplay/play）       |
| `-o FILE`         | 保存到指定文件（默认: `/tmp/metabot-voice-<时间戳>.mp3`） |
| `--provider NAME` | TTS 服务商: `doubao`、`openai`、`elevenlabs`              |
| `--voice ID`      | 声音/音色 ID（各服务商不同）                              |

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
