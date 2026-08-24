# Peers 联邦

跨实例 Bot 发现和任务路由。连接多个 MetaBot 实例 — 同机或远程服务器。

## 概述

Peers 实现了**联邦架构**，多个 MetaBot 实例可以互相发现 Bot 并自动路由任务。适用于：

- 同一台机器上多个用户运行各自的 MetaBot 实例
- 团队在不同服务器上部署 MetaBot
- 跨环境共享专用 Bot

## 工作原理

1. **发现** — 每个实例定期拉取 peer 的 `GET /api/bots`（每 30 秒）
2. **缓存** — Bot 列表本地缓存，快速查找
3. **路由** — 本地找不到的 Bot 名自动转发到对应 peer
4. **防循环** — 转发请求带 `X-MetaBot-Origin` header 防止循环委派
5. **防传递** — 来自 peer 的 Bot 不会再传播（无 transitive 转发）

## 配置

通过**任一种**方式配置即可 — 也可以两种混用（按 URL 自动去重合并）：

=== "环境变量 (.env)"

    最简单的方式 — 直接加到 `.env` 文件。单 Bot 和多 Bot 模式都支持。

    ```bash
    METABOT_PEER_ID=imac
    METABOT_PEERS=http://localhost:9200,http://192.168.1.50:9100
    METABOT_PEER_NAMES=alice,bob
    METABOT_PEER_KEY_IDS=imac-alice-v1,imac-bob-v1
    METABOT_PEER_AUTH_SECRETS=<alice-peer-secret>,<bob-peer-secret>
    ```

    - `METABOT_PEER_ID` — 当前 Bridge 的稳定身份（peer auth 必填）
    - `METABOT_PEERS` — 逗号分隔的 peer URL 列表（必填）
    - `METABOT_PEER_NAMES` — 逗号分隔的显示名称（可选，不填会从 URL 自动推导，如 `localhost-9200`）
    - `METABOT_PEER_KEY_IDS` — 逗号分隔的 peer key ID
    - `METABOT_PEER_AUTH_SECRETS` — 逗号分隔的 peer 专用 Secret，按位置与 URL 对应

    Peer Secret 只能存放在本机 `.env` 使用的 Secret 安全通道中，不得提交或打印。
    `METABOT_PEER_SECRETS` 是旧配置；系统会识别它，但绝不会把其中的值作为 Bridge
    管理员认证发送。

=== "bots.json"

    如果你已经使用 `bots.json` 进行多 Bot 配置，可以在同一个文件里添加 peers。

    ```json
    {
      "feishuBots": [{ "..." }],
      "peers": [
        {
          "name": "alice",
          "url": "http://localhost:9200",
          "auth": {
            "keyId": "imac-alice-v1",
            "secret": "<peer-scoped-secret>",
            "allowedSourceBots": ["alice-bot", "bridge:alice"],
            "allowedTargetBots": ["imac-bot"]
          }
        }
      ]
    }
    ```

    - `name` — peer 的显示名称（必填）
    - `url` — peer 的 API 地址（必填）
    - `auth.keyId` — 当前 peer key 的非敏感标识
    - `auth.secret` — 至少 32 字符的 peer 专用 Secret，不是 Bridge `API_SECRET`
    - `allowedSourceBots` / `allowedTargetBots` — 可选的入站 Bot 范围

    当前 Bridge 必须设置 `METABOT_PEER_ID`。另一侧 Bridge 应把这个值用作对应
    peer 的 `name`，本侧则把另一侧身份作为当前 entry 的 `name`。如果
    `bots.json` 含本机凭据，应设为 `0600`，并放在模型工作区之外。

Peer URL 只应暴露在 loopback、私有网络，或自有鉴权 HTTPS 反向代理之后。

## 认证与权限

静态 Bridge peer 使用 `Authorization: MetaBotPeer ...` 中的短期 HMAC
capability。每个请求都会绑定发行方、目标 Bridge 与 HTTP Host、method/path、
源与目标 Bot、chat ID、request ID、body SHA-256、签发/过期时间和一次性 nonce。
默认有效期为 30 秒。重放、正文篡改、错误路由、过期、未知发行方和已撤销 key
都会 fail closed，并返回稳定错误码。

Peer capability 只能访问：

- Bot、Skill 和 peer 的只读发现；
- `POST /api/talk`（以及已弃用的 `/api/tasks` 别名）；
- 同一 peer 异步请求对应的 `GET /api/talk/:requestId`。

它不能访问 Bot/peer CRUD、schedule、runtime restart/deploy、Agent Teams 管理、
session、文件、数据库或其他管理员 API。同一 Core 的 registry relay 仍可使用普通
Core bearer；静态 peer 绝不会降级使用 Core bearer 或 `API_SECRET`。

Peer 发送从接受到终态使用同一个 request ID。POST 响应丢失时，可以用新 nonce
和同一 request ID 重试；接收端返回已有 task，不会重复执行。

## 轮换、撤销与旧配置迁移

轮换时，先在两侧接收配置的 `auth.acceptKeys` 中加入新 key，并设置有界
`acceptUntil`；然后把两侧的 `auth.keyId`/`auth.secret` 切到新 key，同时只在
重叠期把旧 key 保留在 `acceptKeys`；最后删除旧 key，或把其 ID 加入
`revokedKeyIds`。删除 peer 会立即撤销对应的入站信任。

旧 `peer.secret` / `METABOT_PEER_SECRETS` 会在 peer status 中显示为
`legacy_secret_rejected`，且不会被发送。迁移时为两侧 Bridge 设置稳定 peer ID 和
唯一的 peer 专用 key，先在 staging 确认双向 discovery/talk，再删除旧字段。迁移
前应备份本机配置。代码回退可恢复旧 release 和配置，但也会恢复管理员 Secret
peer 认证，只应作为临时安全回退。

!!! tip "不需要 bots.json"
    如果你只运行一个 Bot，直接在 `.env` 加 `METABOT_PEERS` 就行，不需要 `bots.json`。`bots.json` 的 peers 字段只是多 Bot 配置的便利选项。

## 限定名 {#qualified-names}

使用 `peerName/botName` 语法精确路由：

```bash
# 自动路由 — 先查本地，再按顺序查 peer
metabot talk backend-bot chatId "修复这个 bug"

# 指定 peer — 直接路由到 alice 的 backend-bot
metabot talk alice/backend-bot chatId "修复这个 bug"
```

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/peers` | 列出 peer 及健康状态 |
| `GET` | `/api/bots` | 列出所有 Bot（本地 + peer） |
| `POST` | `/api/talk` | 与 Bot 对话（自动路由到 peer） |

## CLI

```bash
metabot peers                            # 列出 peer 及状态
metabot bots                             # 列出所有 Bot（含 peer）
metabot talk alice/bot chatId "prompt"   # 指定 peer 的 Bot 对话
```

## 健康监控

每 30 秒拉取一次 peer 状态。`GET /api/peers` 返回健康信息：

```json
[
  {
    "name": "alice",
    "url": "http://localhost:9200",
    "healthy": true,
    "lastChecked": 1710000000000,
    "lastHealthy": 1710000000000,
    "botCount": 3,
    "authMode": "peer_capability"
  }
]
```

不健康的 peer 在下次拉取时重试。不可达时清空缓存的 Bot 列表。
