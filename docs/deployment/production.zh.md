# 生产部署

个人版支持的生产部署路径是带签名校验的 GitHub Release 安装器。它会安装四个本地
服务；两个执行守护进程与 Bridge 是 PM2 同级应用，不是 Bridge 子进程：

| 服务 | 默认端口 | 作用 |
|---|---:|---|
| Core Console | `9200` | Web UI、Chat、Agents、Memory、Skills、T5T、Teams、CLI API |
| Bridge | `9100` | IM 渠道、引擎执行、调度、语音与 peer 路由 |
| Worker Runner | `9311` | 持久化的一次性 Codex、Claude、Kimi MCP 工作 |
| ARC | `9312` | 通过 Worker Runner 执行的 AutoResearchClaw 生命周期 |

MetaMemory 已属于 Core，不再存在 `8100` 端口的独立服务。

## 安装与验证

```bash
curl -fsSL https://github.com/xvirobotics/metabot/releases/latest/download/install.sh | bash

metabot status
metabot doctor
curl -fsS http://localhost:9200/health
```

安装器会验证 `SHA256SUMS`、校验个人版 Manifest，构建两个 MCP Package 和适配器，
并且只在 Bridge 与两个守护进程的鉴权健康检查通过后保存 PM2 应用。全部服务健康后
再启用开机启动：

```bash
pm2 save
pm2 startup
```

执行 `pm2 startup` 打印的命令，然后再次运行 `pm2 save`。

## 聊天渠道不需要入站端口

- 飞书/Lark 使用出站长连接 WebSocket。
- Telegram 使用出站 long polling。
- 本地 Web 通过 loopback 访问。

只有明确需要远程浏览器访问时才发布 Core。除非需要独立的鉴权 API，否则 Bridge
应保持在 loopback 或私有网络。

## HTTPS 反向代理

移动端麦克风和远程浏览器访问需要安全上下文。最小 Caddy 配置只代理统一 Core
Console：

```caddy
metabot.example.com {
    reverse_proxy 127.0.0.1:9200
}
```

然后配置远程 CLI：

```bash
export METABOT_CORE_URL=https://metabot.example.com
export METABOT_CORE_TOKEN="<personal-token>"
metabot memory health
```

不需要公网访问时优先使用 Tailscale、WireGuard 等私有网络。不要把 Token 写入 URL、
Shell 历史或共享配置。

## Bridge 远程访问

大多数用户不需要此能力。`metabot bots`、`schedule`、`teams`、`peers` 和 `voice`
使用 Bridge API。确实需要远程访问时：

1. 设置强 `API_SECRET`；
2. 通过独立的鉴权 HTTPS 域名或私有网络代理 `127.0.0.1:9100`；
3. 在客户端设置 `METABOT_URL`。

不要复用 Core Token 作为 Bridge Secret。

## 更新与回退

```bash
metabot update                                  # 最新已校验 Release
metabot update --package --version 1.3.0        # 已知不可变 Release
metabot doctor
```

`metabot start` 与 `metabot stop` 管理 Bridge 和两个执行守护进程。普通
`metabot restart` 只重启 Bridge，因此脱离聊天会话的工作可以继续运行。守护进程
重启必须明确指定：

```bash
metabot restart --request-id <稳定ID> --wait --json
metabot restart --daemon worker
metabot restart --daemon arc
metabot restart --daemon worker --force
```

有活跃工作时默认拒绝重启。`--force` 表示操作者接受后果：状态不明确的工作可能变为
`recovery_required`，系统不会盲目重新执行。

受保护的 Bridge 重启不会删除 PM2 条目。它先在 SQLite 中领取 request ID，再原子
写入 `last-restart.json`，并且只在相同运行目录和脚本上重启 Bridge。相同 request ID
再次提交时会返回持久记录，不会再次重启。新 Bridge 启动后会验证自身 HTTP、两个
守护进程通信端点和 PM2 身份，全部通过后才保存 PM2。普通用户或 PM chat 使用
`--resume` 时，会在原会话里只创建一次续做任务；Agent Team、Worker 和 ARC 内部
chat 仍由各自的持久恢复机制负责。

Package 覆盖会保留 `.env`、`bots.json`、`data/`、`logs/`，以及
`~/.metabot/`、`~/.metabot-core/` 中的用户/Core 状态。如果新版本 smoke 失败，
应显式重装上一已知版本，不要直接修改已安装包文件。

回退到尚未包含执行守护进程的版本时，还要删除已保存的 PM2 条目：

```bash
pm2 delete metabot-worker-runnerd metabot-arcd
pm2 save
```

从源码切换运行目录时，应从 SSH 或 MetaBot 进程树之外的控制器执行
`metabot deploy-runtime --runtime /absolute/checkout`。默认会在有活跃工作时拒绝；
`--force` 会给出 `recovery_required` 提示。命令会先校验目标与回退配置，再按 Worker
Runner、ARC、Bridge 顺序就地切换，不产生 `pm2 delete` 的空档；失败时回退 PM2
已经接受的所有变更。旧控制器不会保存 PM2，只有健康的新 Bridge 才会保存。自动化
重试应使用稳定的 `--request-id`，并用 `--wait --json` 取得持久终态。

## 源码部署

源码 checkout 使用显式路径：

```bash
git pull --ff-only
npm ci --include=dev
npm test
npm run build
metabot update --git
```

Package 管理和源码管理的安装应保持分离。Web 请求路径详见
[Core Console 架构](../features/web-ui.md#architecture)。
