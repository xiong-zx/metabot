# Wiki 同步

MetaMemory 文档单向同步到飞书知识库。MetaMemory 的文件夹树映射为知识库节点；每个文档变成一个飞书 docx 页面。

## 概述

启用后，可以把 MetaMemory 内容同步到飞书知识库：

- **文件夹树** 映射为知识库节点层级
- **文档** 变成飞书 docx 页面
- **变更检测** 使用 hash 对比实现增量同步
- **根节点隔离** 将所有写入限制在一个配置好的 Wiki 子树中
- **自动同步** 可消费 MetaMemory 持久化变更流（默认每 5 秒轮询）

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
| `WIKI_SYNC_ROOT_NODE_TOKEN` | — | 当前主机完整同步树的固定父节点 |
| `WIKI_SYNC_STATE_DIR` | `./data` | 保存目标绑定映射数据库的目录 |
| `WIKI_SYNC_DELETE_REMOTE` | `false` | Memory 删除后删除对应 Wiki 页面；必须配置根节点 |
| `WIKI_AUTO_SYNC` | `false` | 自动消费 Memory 变更 |
| `WIKI_AUTO_SYNC_CONSUMER` | 目标哈希 | 可选持久化消费者游标名称 |
| `WIKI_AUTO_SYNC_POLL_MS` | `5000` | 变更流轮询间隔 |
| `WIKI_AUTO_SYNC_BATCH_SIZE` | `100` | 每轮最多处理的事件数 |
| `WIKI_AUTO_SYNC_FULL_RECONCILE_MS` | `21600000` | 周期性全量对账间隔 |
| `WIKI_AUTO_SYNC_MAX_ATTEMPTS` | `5` | 批次进入 dead-letter 前的重试次数 |
| `WIKI_AUTO_SYNC_WATCH_ROOT` | `/` | 可选 MetaMemory 事件路径前缀 |
| `WIKI_SYNC_THROTTLE_MS` | `300` | API 调用间隔 |
| `FEISHU_SERVICE_APP_ID` | — | 专用飞书应用（回退到第一个 Bot） |
| `FEISHU_SERVICE_APP_SECRET` | — | 服务应用密钥 |

## 所需飞书权限

在飞书开发者控制台添加：

- `wiki:wiki` — 读写知识库页面
- `docx:document` — 创建/编辑文档
- `docx:document:readonly` — 读取文档
- `drive:drive` — 访问云文档

## 根节点隔离与删除

自动同步会严格校验配置；只有显式设置 `WIKI_SPACE_ID`、
`WIKI_SYNC_ROOT_NODE_TOKEN` 和 `WIKI_SYNC_STATE_DIR` 才能启用。首次运行先做
全量快照，并把持久化消费者初始化到事件流头部。之后按文档合并批次，只有整批成功才推进游标；
失败批次可跨 Bridge 重启重试，超过限制后进入 dead-letter。周期性全量对账用于覆盖
文档事件未表达的变化，手动 `/sync` 始终可用。

- 远端删除默认关闭。更新、移动或删除已有映射前，都会验证节点属于配置根节点的子树。

多台主机共享同一个 Space 时，每台主机必须使用不同的根节点和状态目录，使目标绑定和映射彼此独立。
默认消费者名称由 Space 和根节点 token 派生，因此共享同一个 Memory Core 的主机不会共用游标。

不要把已有映射的状态目录改指向另一个 Space 或根节点。目标绑定不可变；更换目标时
应使用新的空 `WIKI_SYNC_STATE_DIR`。

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/sync` | 触发全量同步 |
| `GET` | `/api/sync` | 同步状态 |
| `POST` | `/api/sync/document` | 按 ID 同步单个文档 |
