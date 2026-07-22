# 生产部署

## 快速启动

```bash
metabot start                       # 用 PM2 启动
metabot update                      # 内网包更新 + 构建 + 更新 skills + 重启
metabot restart --wait              # 重启当前 runtime
metabot deploy-runtime --runtime /path/to/metabot # 从 SSH 切换 runtime
```

## PM2 开机自启

```bash
pm2 startup && pm2 save
```

注册为系统服务，开机自动启动。

## 手动 PM2 命令

优先使用 MetaBot CLI：它会持久化 restart request、保留代理环境、验证健康，
且只在成功后保存 PM2 process list。禁止从 MetaBot 子进程中先执行
`pm2 delete metabot` 再执行 `pm2 start`；delete 会先杀死本应执行第二条
命令的进程树。

```bash
pm2 start ecosystem.config.cjs      # 启动
pm2 restart metabot --update-env     # 同 runtime 紧急重启
pm2 stop metabot                     # 停止
pm2 logs metabot                     # 查看日志
pm2 status                           # 进程状态
```

切换 worktree/runtime 时，通过 `metabot deploy-runtime` 向 PM2 daemon
只提交一次 restart RPC；命令会解析并核对目标 `cwd` 和 script，不删除 PM2
应用条目。必须从 SSH 或 MetaBot 进程树之外的 supervisor 执行，并会拒绝
进程内 runtime 切换。原子切换会从当前进程继承共享 bot 配置、凭证引用、
会话存储、Wiki/MetaMemory 状态目录和网络设置；`METABOT_HOME` 等运行时专属
配置仍由目标 ecosystem 决定。

## 生产构建

```bash
npm run build                        # TypeScript 编译到 dist/
npm start                            # 运行编译后的 dist/index.js
```

## 不需要公网 IP

- **飞书** 使用 WebSocket（长连接）— 不需要入站端口
- **Telegram** 使用长轮询 — 不需要入站端口

唯一需要可访问的端口是 API 端口（默认 `9100`），用于远程 CLI 访问或 Peers 联邦。

## 远程 CLI 访问

配置 CLI 工具连接远程 MetaBot 实例：

```bash
# 在 ~/.metabot/.env 中
METABOT_URL=http://your-server:9100
META_MEMORY_URL=http://your-server:8100
API_SECRET=your-secret
```

这样 `metabot` 的 bridge 守护进程 API 命令可以从任何机器使用。

## HTTPS（Caddy 反向代理）

移动端浏览器的 Web UI 电话语音模式需要 HTTPS（麦克风需要安全上下文）。推荐 [Caddy](https://caddyserver.com/) 做反向代理 — 自动管理 Let's Encrypt 证书。

```bash
# 安装 Caddy
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install caddy

# 配置（替换为你的域名）
sudo tee /etc/caddy/Caddyfile > /dev/null << 'EOF'
metabot.yourdomain.com {
    reverse_proxy localhost:9100
}
EOF
sudo systemctl restart caddy
```

**前提条件：**

- 域名 A 记录指向服务器公网 IP
- 开放 80 和 443 端口用于 Let's Encrypt 验证

Caddy 自动获取和续期证书。WebSocket 连接（`/ws`）透明代理，无需额外配置。

详细设置步骤见 [Web UI 文档](../features/web-ui.md#https)。
