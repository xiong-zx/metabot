# 环境变量

每个 Bot 的引擎、工作区和渠道设置放在 `bots.json`；整套部署共享的运行时设置放在
`.env`。复制 `.env.example` 后，只添加实际需要的变量。

## Core 与 Bridge

| 变量 | 默认值 | 作用 |
|---|---|---|
| `BOTS_CONFIG` | — | 多 Bot 配置路径，通常为 `./bots.json` |
| `METABOT_ENGINE` | `codex` | 单 Bot 默认引擎：`codex`、`kimi` 或兼容 `claude` |
| `API_PORT` | `9100` | 本地 Bridge API 端口 |
| `API_SECRET` | — | Bridge Bearer Secret；为空时只监听 localhost |
| `METABOT_URL` | `http://localhost:9100` | Bridge CLI 命令使用的地址 |
| `METABOT_CORE_URL` | `http://localhost:9200` | Core Console 与委托 CLI 地址 |
| `METABOT_CORE_TOKEN` | Token 文件 | 覆盖 `~/.metabot-core/token` |
| `METABOT_CORE_HOST` | `127.0.0.1` | Core 监听地址 |
| `METABOT_CORE_PORT` | `9200` | Core 端口 |
| `METABOT_CORE_DATA_DIR` | `~/.metabot-core/data` | Core 数据目录 |
| `METABOT_PUBLIC_DISTRIBUTION` | `0` | 匿名提供 Core 安装/CLI 资源；仅在明确需要时开启 |
| `METABOT_NODE_INTERPRETER` | 当前 `node` 可执行文件 | 固定到所有 PM2 应用的 Node.js >=22.19 绝对路径；适合系统 Node 仍较旧的升级环境 |
| `LOG_LEVEL` | `info` | Bridge 日志级别 |

Memory、Skills、Agents 和 T5T 都由 `METABOT_CORE_URL` 指向的 Core 提供。旧的独立
MetaMemory 变量和 `8100` 端口不属于当前个人版。

## 执行守护进程

| 变量 | 默认值 | 作用 |
|---|---|---|
| `METABOT_STATE_DIR` | `~/.metabot` | 守护进程 SQLite 状态与默认 ARC 项目根目录的上级目录 |
| `METABOT_KEYS_DIR` | `~/.metabot/keys` | 运行目录之外的 Ed25519 密钥与 ARC 服务凭证目录 |
| `METABOT_WORKER_DAEMON_URL` | `http://127.0.0.1:9311/mcp` | Worker Runner 本机 MCP 地址 |
| `METABOT_WORKER_DATA_DIR` | `~/.metabot/worker-runner` | Worker Runner SQLite 状态与独占锁 |
| `METABOT_ARC_DAEMON_URL` | `http://127.0.0.1:9312/mcp` | ARC 本机 MCP 地址 |
| `METABOT_ARC_DATA_DIR` | `~/.metabot/arc` | ARC SQLite 状态与独占锁 |
| `METABOT_ARC_PROJECT_ROOTS` | `["~/.metabot/arc-projects"]` | ARC 信任的规范项目根目录 JSON 数组 |
| `METABOT_ARC_WORKER_ENGINE` | `codex` | ARC 适配器调用的一次性工作引擎 |

健康检查通过短期签名凭证执行只读 MCP 调用；守护进程不提供未鉴权健康接口。

## 工作区与引擎

| 变量 | 默认值 | 作用 |
|---|---|---|
| `CLAUDE_DEFAULT_WORKING_DIRECTORY` | — | 历史单 Bot 工作区变量，所有引擎都会使用 |
| `CODEX_MODEL` | Codex 默认 | Codex 模型 |
| `CODEX_PROFILE` | — | Codex 配置 Profile |
| `CODEX_API_KEY` | 登录状态 | OpenAI 兼容 Key，会映射到 `OPENAI_API_KEY` |
| `CODEX_BASE_URL` | Codex 默认 | OpenAI 兼容 API 地址 |
| `CODEX_APPROVAL_POLICY` | `never` | Codex 批准策略 |
| `CODEX_SANDBOX` | `workspace-write` | Codex Sandbox 模式 |
| `CODEX_REASONING_EFFORT` | — | `low`、`medium`、`high`、`xhigh`、`max` 或 `ultra` |
| `CODEX_EXECUTABLE_PATH` | 自动 | Codex 二进制路径 |
| `KIMI_CODE_SERVER_URL` | `http://127.0.0.1:58627` | 已有本地 Kimi Server；否则按需启动 |
| `KIMI_CODE_HOME` | `~/.kimi-code` | Kimi 配置和本地 Token 目录 |
| `KIMI_API_KEY` | 登录状态 | 本地 Kimi Server 继承的可选 Provider Key |
| `CLAUDE_MODEL` | Claude 默认 | 兼容引擎模型 |
| `CLAUDE_EXECUTABLE_PATH` | 自动 | Claude 兼容二进制路径 |

工作区、引擎、模型、Sandbox 和 Kimi 权限优先在每个 Bot 的 `bots.json` 中配置。
详见[多 Bot 与引擎](multi-bot.md)。

## 渠道

| 变量 | 默认值 | 作用 |
|---|---|---|
| `FEISHU_APP_ID` | — | 单 Bot 飞书/Lark App ID |
| `FEISHU_APP_SECRET` | — | 单 Bot 飞书/Lark App Secret |
| `FEISHU_DOMAIN` | `feishu` | API 租户：`feishu` 或 `lark`；其他值会报错 |
| `TELEGRAM_BOT_TOKEN` | — | 单 Bot Telegram Token |
| `METABOT_FEISHU_WS_PING_TIMEOUT_SEC` | `20` | 飞书 WebSocket Pong 超时 |
| `METABOT_FEISHU_WS_HANDSHAKE_TIMEOUT_MS` | `15000` | 飞书连接/重连超时 |
| `METABOT_LOCAL_ADDRESS` | — | 飞书 Socket 可选源 IP |

多 Bot 部署应把渠道凭证放在受保护的 `bots.json`，不要在 `.env` 中重复维护。

## 可选服务

| 变量 | 默认值 | 作用 |
|---|---|---|
| `METABOT_CORE_MEMORY_WRITE_ROOTS` | `/users,/shared,/metabot` | 公开 Memory API 允许创建或更新的顶层路径 |
| `METABOT_CORE_MEMORY_SERVER_ROOT` | — | 本服务器额外的 MetaMemory 顶层命名空间，例如 `/cargo1` |
| `METABOT_MEMORY_INDEX_AUTOMATION` | `off` | 增量索引模式：`off`、`events`（仅 outbox）、`dry-run`、`routing` 或双门禁 `full` |
| `METABOT_MEMORY_INDEX_QUALITY_APPROVED` | `false` | 操作者确认已通过文档中的 P5 质量合同；`full` 必需 |
| `METABOT_MEMORY_INDEX_AUTO_APPLY_ENABLED` | `false` | P5 状态写入的独立 kill switch；`full` 必需 |
| `METABOT_MEMORY_INDEX_WATCH_ROOT` | server root 或 `/cargo1` | 索引消费者监视的语义范围 |
| `METABOT_MEMORY_INDEX_STATUS_PATH` | `<watch-root>/status/project-progress-status` | dry-run 提案使用的状态文档 |
| `METABOT_MEMORY_INDEX_TARGET_BOT` | `memory` | 生成有界状态提案的 Bot |
| `METABOT_MEMORY_INDEX_CONSUMER` | 按模式 | 持久化事件消费者游标名；`full` 默认为 `memory-status-full`，其他模式默认为 `memory-status-dry-run` |
| `METABOT_MEMORY_INDEX_POLL_MS` | `60000` | 事件轮询间隔 |
| `METABOT_MEMORY_INDEX_RECONCILE_MS` | `900000` | 只读对账间隔 |
| `METABOT_MEMORY_INDEX_BATCH_SIZE` | `50` | 每轮最多读取的事件数 |
| `METABOT_MEMORY_INDEX_MAX_ATTEMPTS` | `3` | 提案失败进入 dead-letter 前的重试次数 |
| `METABOT_MEMORY_ROUTING_REBUILD_ENABLED` | `false` | Core 端确定性路由索引重建写入门禁 |
| `SCHEDULE_TIMEZONE` | 系统时区 | Cron 任务使用的 IANA 时区 |
| `METABOT_PEERS` | — | 逗号分隔的 Peer URL |
| `METABOT_PEER_SECRETS` | — | 与 Peer URL 对应的 Secret |
| `METABOT_PEER_NAMES` | 自动 | Peer 显示名称 |
| `METABOT_ALLOWED_PEER_CIDRS` | — | 可选 IPv4 CIDR 转发白名单 |
| `FEISHU_SERVICE_APP_ID` | 第一个飞书 Bot | 可选 Wiki/文档读取 Service App |
| `FEISHU_SERVICE_APP_SECRET` | 第一个飞书 Bot | Service App Secret |
| `FEISHU_SERVICE_DOMAIN` | `feishu` | 独立 Service App 的租户：`feishu` 或 `lark` |
| `WIKI_SYNC_ENABLED` | `true` | 启用可选 Memory-to-Wiki 同步 |
| `WIKI_SPACE_ID` | — | 已有 Wiki Space ID |
| `WIKI_SPACE_NAME` | `MetaMemory` | Wiki Space 名称 |
| `VOLCENGINE_TTS_APPID` | — | 豆包 STT/TTS App ID |
| `VOLCENGINE_TTS_ACCESS_KEY` | — | 豆包 STT/TTS Access Key |
| `OPENAI_API_KEY` | — | 可选 Whisper/OpenAI TTS Fallback |
| `ELEVENLABS_API_KEY` | — | 可选 ElevenLabs TTS Key |

完整 Provider 与 RTC 变量仍以内联注释写在 `.env.example` 中；源码部署以它为真值。

在飞书与 Lark 之间迁移应用时，请按 [Lark 域名迁移指南](lark-domain-migration.md)
操作。App、聊天、用户、Wiki、节点和文档 ID 都属于各自租户，不能跨租户复制。

## 代理

生产守护进程支持 `HTTP_PROXY`、`HTTPS_PROXY`、`http_proxy`、`https_proxy`、
`NO_PROXY` 和 `no_proxy`。这些普通代理变量可以进入 Worker Runner 的安全白名单；
看起来像密码、Token 或 API 凭证的代理变量即使写入白名单也会被拒绝。应在 `NO_PROXY` 中包含
`localhost` 和 `127.0.0.1`，保证 Core、Bridge 与本地 Kimi Server 流量不经过代理。

不要提交已填写的 `.env` 或 `bots.json`。
