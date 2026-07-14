# Wiki 同步

MetaMemory 文档单向同步到飞书知识库。MetaMemory 的文件夹树映射为知识库节点；每个文档变成一个飞书 docx 页面。

## 概述

启用后，MetaMemory 内容自动同步到飞书知识库：

- **文件夹树** 映射为知识库节点层级
- **文档** 变成飞书 docx 页面
- **变更检测** 对 MetaMemory 文件夹树和文档摘要计算快照 hash
- **自动同步** 轮询 MetaMemory 变更，发现变化后防抖触发同步

## 聊天命令

| 命令 | 说明 |
|------|------|
| `/sync` | 触发全量同步 |
| `/sync status` | 查看同步统计 |

## 配置

| 变量 | 默认 | 说明 |
|------|------|------|
| `WIKI_SYNC_ENABLED` | `true` | 启用知识库同步 |
| `WIKI_SPACE_ID` | — | 飞书知识库空间 ID |
| `WIKI_SPACE_NAME` | `MetaMemory` | 知识库空间名称（不存在则创建） |
| `WIKI_AUTO_SYNC` | `true` | MetaMemory 变更时自动同步 |
| `WIKI_AUTO_SYNC_ON_START` | `true` | 启动时捕获基线后执行一次同步 |
| `WIKI_AUTO_SYNC_POLL_MS` | `60000` | 快照轮询间隔 |
| `WIKI_AUTO_SYNC_DEBOUNCE_MS` | `5000` | 防抖延迟 |
| `WIKI_SYNC_THROTTLE_MS` | `300` | API 调用间隔 |
| `METABOT_CORE_MEMORY_SERVER_ROOT` | — | 本服务器的 MetaMemory 顶层命名空间，例如 `/cargo1`；设置后会加入 Memory API 可写根 |
| `FEISHU_SERVICE_APP_ID` | — | 专用飞书应用（回退到第一个 Bot） |
| `FEISHU_SERVICE_APP_SECRET` | — | 服务应用密钥 |

## 多服务器同步

同步器会按 MetaMemory 路径原样生成知识库层级。多台服务器同步到同一个 `WIKI_SPACE_ID` 时，每台服务器应使用不同的顶层目录，例如：

- cargo1: `/cargo1/dev`, `/cargo1/ideas`, `/cargo1/ops`
- 另一台服务器: `/<server-name>/dev`, `/<server-name>/ideas`, `/<server-name>/ops`

在每台服务器的 `.env` 中设置本机命名空间和同一个知识库空间：

```bash
METABOT_CORE_MEMORY_SERVER_ROOT=/cargo1
WIKI_SPACE_ID=<shared_space_id>
WIKI_SYNC_ENABLED=true
WIKI_AUTO_SYNC=true
```

旧数据从 `/metabot` 迁移到服务器根路径：

```bash
metabot memory move-folder /metabot --path /cargo1
```

folder 和 document ID 会保留。路径变更后下一次同步会在新的知识库层级下创建新映射；旧的 `/metabot` 知识库页面不会被自动删除，需要确认无误后手动清理。

## 创建知识库空间

推荐先手动或用用户身份创建一个专用知识库空间，再把空间 ID 写入 `WIKI_SPACE_ID`。不要依赖自动建空间作为常规部署路径，因为创建空间需要用户身份，运行时同步通常使用应用 / bot 身份。

手动方式：

1. 在飞书进入「知识库」。
2. 创建一个团队知识库，例如 `MetaMemory`。
3. 进入知识库成员 / 权限设置。
4. 添加 MetaBot 对应的飞书应用，成员类型为应用，角色可先用普通成员。
5. 获取该知识库的 `space_id` 并写入 `.env`。

CLI 方式：

```bash
lark-cli auth login --scope "wiki:space:write_only wiki:space:retrieve wiki:member:create" --no-wait --json
lark-cli auth login --device-code <device_code>

lark-cli wiki +space-create \
  --name MetaMemory \
  --description "MetaBot MetaMemory sync target" \
  --as user \
  --format json

lark-cli wiki +member-add \
  --space-id <space_id> \
  --member-id <feishu_app_id> \
  --member-type appid \
  --member-role member \
  --as user
```

如果只有知识库 URL，不要手动猜 `space_id`。先解析 URL 里的 wiki token：

```bash
lark-cli wiki spaces get_node \
  --params '{"token":"<wiki_token_from_url>"}' \
  --as user \
  --format json
```

然后在 `.env` 中设置：

```bash
WIKI_SPACE_ID=<space_id>
```

## 所需飞书权限

在飞书开发者控制台添加：

- `wiki:wiki` — 读写知识库页面
- `wiki:space:retrieve` — 读取知识空间列表（若使用 `wiki:wiki` 覆盖该能力，也可以不单独添加）
- `docx:document` — 创建/编辑文档
- `docx:document:readonly` — 读取文档
- `drive:drive` — 访问云文档

如果日志出现 `99991672` 或 `99991663`，通常表示应用身份还没有启用对应 Wiki 权限，或应用版本尚未发布生效。先在飞书开发者控制台补齐权限并发布，再把应用加入目标知识库空间；已有空间建议直接设置 `WIKI_SPACE_ID`，避免自动建空间失败。

## PM2 环境变量

Bridge 启动时会读取 `.env`，但 PM2 进程里已经存在的环境变量优先级更高。修改 `WIKI_*` 配置后，用下面的方式让 PM2 刷新环境：

```bash
set -a
source /root/metabot/.env
set +a
pm2 restart metabot --update-env
```

## 自动同步行为

- Bridge 默认每 60 秒轮询一次 MetaMemory 快照
- 快照变化后触发同步，5 秒防抖
- 多次快速变更合并处理
- 自动同步调用和 `/sync` 相同的全量同步管线
- 全量同步内部使用 content hash 跳过未变化文档，因此只会重写变化页面
- 手动 `/sync` 始终可用

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/sync` | 触发全量同步 |
| `GET` | `/api/sync` | 同步状态 |
| `POST` | `/api/sync/document` | 按 ID 同步单个文档 |
