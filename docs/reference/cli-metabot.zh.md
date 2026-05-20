# metabot CLI

`metabot` 是 MetaBot 唯一的 CLI 入口，包含三类命令：

1. **bridge 进程控制** —— 管理本地 MetaBot 服务生命周期。
2. **bridge 守护进程 API** —— curl 本地 bridge 守护进程（`localhost:9100`）。
3. **metabot-core 转发** —— 转发给中心功能 CLI。

## 安装

MetaBot 安装器自动安装到 `~/.local/bin/metabot`。

> 旧的 `mb` 命令现在是一个薄薄的弃用兼容壳，转发到 `metabot`。`mb skills`
> 映射到 `metabot bot-skills`，其余命令原样转发。请将脚本更新为直接调用
> `metabot`。

## 1. bridge 进程控制

```bash
metabot update                      # 拉取最新代码，重新构建，更新 skills，重启
metabot start                       # 启动（PM2）
metabot stop                        # 停止
metabot restart                     # 重启
metabot logs                        # 查看实时日志（可传 -n 100 等）
metabot status                      # PM2 进程状态
```

`metabot update` 是推荐的更新方式。它依次执行：

1. `git pull` — 拉取最新代码
2. `npm install && npm run build` — 重新构建
3. 复制 MetaBot 内置 skills 到 Claude/Codex skill 目录
4. 如果本机已安装 `lark-cli` 或 lark skills，自动更新 `@larksuite/cli` 并刷新 lark AI Agent skills
5. 同步 skills 到已配置的 bot 工作目录
6. `pm2 restart` — 重启服务

一条命令搞定。

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

Bot 名称支持[限定名](../features/peers.md#限定名)（`peerName/botName`）实现跨实例
路由。这是 bridge 本地的对话路径；`metabot agents talk` 是基于中心注册表的 P2P
变体。

### Peers

```bash
metabot peers                       # 列出 peer 及状态
```

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

### 每个 Bot 的 Skill Hub

```bash
metabot bot-skills list                          # 列出所有技能（本地 + peer）
metabot bot-skills search <query>                # 按关键词搜索技能
metabot bot-skills get <name>                    # 获取技能详情
metabot bot-skills publish <botName> <skillName> # 发布 Bot 的技能到 hub
metabot bot-skills install <skillName> <botName> # 安装技能到 Bot
metabot bot-skills remove <name>                 # 取消发布技能
```

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
