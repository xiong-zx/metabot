# 环境变量

所有配置通过 `.env` 文件或系统环境变量。复制 `.env.example` 到 `.env` 开始使用。

## MetaBot 核心

| 变量 | 默认 | 说明 |
|------|------|------|
| `BOTS_CONFIG` | — | `bots.json` 路径（多 Bot 模式） |
| `FEISHU_APP_ID` | — | 飞书 App ID（单 Bot 模式） |
| `FEISHU_APP_SECRET` | — | 飞书 App Secret（单 Bot 模式） |
| `API_PORT` | `9100` | HTTP API 端口 |
| `API_SECRET` | — | Bearer Token 认证 |
| `LOG_LEVEL` | `info` | 日志级别（debug, info, warn, error） |
| `METABOT_LOCAL_ADDRESS` | — | 所有飞书 socket（REST + wss 长连接）绑定到该本机源 IP，触发 source-based routing 绕过 VPN 智能分流（如某些企业 VPN 把 `*.feishu.cn` 劫持进失效隧道）。不设则走默认路由 |

## Claude Code

| 变量 | 默认 | 说明 |
|------|------|------|
| `DEFAULT_WORKING_DIRECTORY` | — | Claude 工作目录（单 Bot 模式） |
| `CLAUDE_MAX_TURNS` | 不限 | 每次请求最大轮次 |
| `CLAUDE_MAX_BUDGET_USD` | 不限 | 每次请求费用上限（美元） |
| `CLAUDE_MODEL` | SDK 默认 | Claude 模型 |
| `CLAUDE_EXECUTABLE_PATH` | 自动检测 | `claude` 二进制路径 |

## Codex CLI

| 变量 | 默认 | 说明 |
|------|------|------|
| `CODEX_MODEL` | Codex 默认 | Codex 模型 |
| `CODEX_API_KEY` | — | Codex 的 OpenAI 兼容 API Key。子进程里会标准化成 `OPENAI_API_KEY` |
| `CODEX_BASE_URL` | Codex 默认 | OpenAI 兼容 API Base URL。会传给 Codex：`-c openai_base_url="..."` |
| `CODEX_PROFILE` | — | Codex 配置 profile |
| `CODEX_APPROVAL_POLICY` | `never` | 审批策略（`untrusted`、`on-failure`、`on-request`、`never`） |
| `CODEX_SANDBOX` | `danger-full-access` | 沙箱模式（`read-only`、`workspace-write`、`danger-full-access`） |
| `CODEX_EXECUTABLE_PATH` | 自动检测 | `codex` 二进制路径 |

## MetaMemory

| 变量 | 默认 | 说明 |
|------|------|------|
| `MEMORY_ENABLED` | `true` | 启用内嵌 MetaMemory |
| `MEMORY_PORT` | `8100` | MetaMemory 端口 |
| `MEMORY_SECRET` | `API_SECRET` | MetaMemory 认证（旧版） |
| `MEMORY_ADMIN_TOKEN` | — | 管理员 Token（完整访问） |
| `MEMORY_TOKEN` | — | 读者 Token（仅 shared 文件夹） |
| `META_MEMORY_URL` | `http://localhost:8100` | MetaMemory 地址（CLI 远程访问） |
| `METABOT_CORE_MEMORY_WRITE_ROOTS` | `/users,/shared,/metabot` | 公开 Memory API 允许写入的顶层路径，逗号分隔 |
| `METABOT_CORE_MEMORY_SERVER_ROOT` | — | 本服务器的 MetaMemory 顶层命名空间，例如 `/cargo1`；设置后会加入 Memory API 可写根 |
| `METABOT_ASYNC_TASK_STALE_MS` | `86400000` | `/api/talk?async=true` 任务超过该时长仍未完成时标记为 `task_expired` |

## 飞书服务应用

| 变量 | 默认 | 说明 |
|------|------|------|
| `FEISHU_SERVICE_APP_ID` | — | 专用于知识库同步和文档阅读的飞书应用 |
| `FEISHU_SERVICE_APP_SECRET` | — | 服务应用密钥 |

未设置时回退到第一个飞书 Bot 的凭证。

## Wiki 同步

| 变量 | 默认 | 说明 |
|------|------|------|
| `WIKI_SYNC_ENABLED` | `true` | 启用 MetaMemory → 知识库同步 |
| `WIKI_SPACE_ID` | — | 飞书知识库空间 ID |
| `WIKI_SPACE_NAME` | `MetaMemory` | 知识库空间名称 |
| `WIKI_AUTO_SYNC` | `true` | 变更时自动同步 |
| `WIKI_AUTO_SYNC_ON_START` | `true` | 启动时捕获基线后执行一次同步 |
| `WIKI_AUTO_SYNC_POLL_MS` | `60000` | 快照轮询间隔 |
| `WIKI_AUTO_SYNC_DEBOUNCE_MS` | `5000` | 防抖延迟 |
| `WIKI_SYNC_THROTTLE_MS` | `300` | API 调用间隔 |

## Peers 联邦

| 变量 | 默认 | 说明 |
|------|------|------|
| `METABOT_PEERS` | — | 逗号分隔的 peer URL |
| `METABOT_PEER_SECRETS` | — | 逗号分隔的 peer secret（位置对应） |
| `METABOT_PEER_NAMES` | 自动 | 逗号分隔的 peer 名称 |
| `METABOT_PEER_POLL_INTERVAL_MS` | `30000` | peer 拉取间隔 |
| `METABOT_ALLOWED_PEER_CIDRS` | — | 可选的逗号/空格分隔 IPv4 CIDR 白名单。设置后，任务转发仅允许目标 peer 的字面 IPv4 地址落在指定范围内。基于主机名的 peer 仍受已知 peer 白名单约束，但不受 CIDR 过滤。不设置 = 无 CIDR 约束。示例：`10.0.0.0/8,192.168.0.0/16` |

## 远程访问

| 变量 | 默认 | 说明 |
|------|------|------|
| `METABOT_URL` | `http://localhost:9100` | MetaBot API 地址（CLI 用） |
| `META_MEMORY_URL` | `http://localhost:8100` | MetaMemory 地址（CLI 用） |

## 语音

| 变量 | 默认 | 说明 |
|------|------|------|
| `VOLCENGINE_TTS_APPID` | — | 豆包 STT + TTS（推荐） |
| `VOLCENGINE_TTS_ACCESS_KEY` | — | 豆包 STT + TTS（推荐） |
| `VOLCENGINE_TTS_RESOURCE_ID` | `volc.service_type.10029` | 豆包 TTS 资源 ID |
| `OPENAI_API_KEY` | — | Whisper STT + OpenAI TTS 备选 |
| `ELEVENLABS_API_KEY` | — | ElevenLabs TTS |
| `VOICE_MODEL` | — | 语音模式使用的 Claude 模型（可选覆盖） |

## 第三方 AI 服务商

支持任何 Anthropic 兼容 API：

```bash
# Kimi/月之暗面
ANTHROPIC_BASE_URL=https://api.moonshot.ai/anthropic
ANTHROPIC_AUTH_TOKEN=你的key

# DeepSeek
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
ANTHROPIC_AUTH_TOKEN=你的key

# GLM/智谱
ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic
ANTHROPIC_AUTH_TOKEN=你的key
```
