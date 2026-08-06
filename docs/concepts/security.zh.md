# 安全

MetaBot Agent 可以在配置的工作区中读、写和执行代码。应把工作区、引擎策略、
渠道可见范围和本地 Token 视为同一条安全边界。

## 引擎执行

### Codex

个人版默认配置为：

```text
approvalPolicy = never
sandbox = workspace-write
```

Codex 不会等待交互批准，但文件系统范围仍限制在配置的工作区。只有当主机本身就是
明确的隔离边界时，才启用 `danger-full-access` 或
`CODEX_BYPASS_APPROVALS_AND_SANDBOX=true`。

### Kimi Code

Kimi 默认使用 `permissionMode: auto`，MetaBot 不会自动批准待处理工具请求。只有在
可信工作区确实需要无人值守执行时才设置 `permissionMode: yolo`。Kimi Server URL
默认只允许 loopback，避免把本地凭证发送到远程服务。

### Claude 兼容模式

Claude 工作区保留兼容权限行为。建议使用非 root 服务账号，并把每个 Bot 限制在最小
必要工作区。

## Core Console Token

安装器会创建权限为 `0600` 的 `~/.metabot-core/token`。该 Token 可以访问 Chat、
Agents、Memory、Skills、T5T、Teams 和 CLI API。

```bash
stat -c '%a %n' ~/.metabot-core/token
```

- 不要提交 Token，也不要把它粘贴到日志中；
- Token 泄露后应立即轮换；
- 除非位于自有鉴权 HTTPS 代理或私有网络之后，否则 Core 应保持 loopback 绑定。

## Bridge API

当 `API_SECRET` 为空时，Bridge `9100` 端口只绑定 localhost。确实需要远程 Bridge
命令时，应生成独立 Secret，并在自有代理终止 TLS：

```bash
openssl rand -hex 32
```

不要把原始 `9100` 或 `9200` 端口直接暴露到公网。

## 渠道

- 限制飞书/Lark 应用可见范围，只发布必要权限。
- 不要在 `bots.json` 副本、截图或 Issue 中泄露 Telegram、微信 Token。
- 群聊使用精确 `@Bot` 路由；回复模式变更由群主控制，无法验证群主时 fail-closed。

## Memory 共享

Memory 路径只组织文档，不授予访问权限。只有显式共享的文档才能被其他 Agent 读取：

```bash
metabot memory create "私有" "..." --no-share
metabot memory share <document-id> on
```

不要在共享 Memory 中保存凭证、设备码或授权链接。

## 推荐基线

1. 每套部署使用一个最小权限服务账号。
2. 每个 Bot 只配置所需工作区。
3. Codex 保持 `workspace-write`，Kimi 保持 `auto`，除非有明确理由扩大权限。
4. 本地 Token 保持 `0600`，原始服务只监听 loopback。
5. 定期检查 Core Console 中的 Run、工具和输出文件活动。
6. 使用 `metabot update` 通过已校验的 GitHub Release 更新。
