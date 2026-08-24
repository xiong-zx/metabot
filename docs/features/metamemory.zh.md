# MetaMemory

MetaMemory 是 Core Console 内置的持久知识层。它用可搜索的文件夹树保存
Markdown 或 HTML 文档，并把是否共享作为每篇文档的显式选择。

## 使用入口

- **Web：** 打开 `http://localhost:9200/memory`，输入本地 Core Token。
- **CLI：** 使用 `metabot memory ...`；旧的 `mm` 二进制已不再支持。
- **Agent：** 安装或启用 MetaMemory Skill，让 Agent 在运行中搜索和更新知识。

## 常用命令

```bash
metabot memory search "部署指南"
metabot memory list
metabot memory get <document-id>
metabot memory path /users/me/project/guide

metabot memory create "指南" "# 部署" --share --tags docs,release
echo '# 更新后的指南' | metabot memory update <document-id>
metabot memory share <document-id> on
metabot memory mkdir project-notes --path /users/me/project-notes
metabot memory delete <document-id>
metabot memory health
```

省略内容参数时，`create` 和 `update` 会从标准输入读取。Markdown 是默认格式；
只有完整 HTML 文档才需要 `--html`。

## 增量索引维护

文档变更会生成事务性、带版本的 change outbox。创建、更新、删除、文件夹移动/改名
和递归删除都会为每个受影响文档生成一条事件。更新可传入
`--expected-version N`；旧版本写入会返回 `409 version_conflict`，且不会修改文档或
生成事件。

事件检查和对账仅限管理员：

```bash
metabot memory events --after 0 --limit 50 --prefix /cargo1
metabot memory event-stats
metabot memory index-reconcile --root /cargo1
metabot memory index-proposals memory-status-dry-run
metabot memory index-review memory-status-dry-run 123 corrected
```

Bridge 自动维护默认是 `off`。`events` 只提供 outbox，不启动消费者；`dry-run` 会合并
相关事件，排除 `/index`、`/status` 和 indexer 来源写入，并保存有界的一行提案及
复核遥测，但不会更新状态文档。Core 短暂性请求失败会暂停当前批次且不消耗重试次数；
确定性失败会有界重试，最后进入 dead-letter。

P5 `full` 模式最多只会修改 Current Projects 表中一条已有项目行。它同时要求
`METABOT_MEMORY_INDEX_QUALITY_APPROVED=true` 和
`METABOT_MEMORY_INDEX_AUTO_APPLY_ENABLED=true`，后者是独立 kill switch。
只有项目行唯一、文档版本仍匹配、仅 `Status`、`Current State` 或 `Next Action`
发生变化，且每个新增有意义事实都能在有界源事件中找到时，才允许自动写入。
其他提案仅供人工复核。成功写入使用 CAS，生成 `reconciler` 事件，并记录前后哈希、
行内容、改动列、有界源证据快照、路径和版本。
处理状态会同步镜像到不依赖 outbox 外键的持久审计表，因此事件保留期清理不会删除
P5 复核或回滚证据。
默认 `memory-status-full` 消费者在首次使用时会从当前事件头开始，因此启用 P5 不会重放
过期历史变更。只有受控 canary 确实要处理某个较早游标时，才预先创建一个显式命名的消费者。

P5 质量合同默认失败关闭：至少 30 个标注样例、10 个实质性样例和 5 个自动写入样例；
决策准确率至少 95%；自动写入精度 100%；修正率不高于 5%；严重错误和结构错误都为 0。
自动对抗测试证明确定性规划器、顺序、重试、恢复和审计保护的执行，但不证明 live 模型的语义准确性。
在真实标注模型评估满足合同、且受控 live canary 获得批准之前，两个 `full` 门禁都必须保持 `false`。

结束 PM2 live dry-run 窗口时，必须在受保护重启前显式设置
`METABOT_MEMORY_INDEX_AUTOMATION=off`。只从 `.env` 删除该键不会清除 PM2 已继承的
值。宣布窗口结束前，要检查重启后的 `Memory index automation configured` 日志。

路由索引使用文档级结构化元数据：

```bash
metabot memory update DOC_ID \
  --index-role todo \
  --project-key memory \
  --index-keywords todo,memory \
  --index-summary "Canonical memory work items."

metabot memory routing-preview --root /cargo1
```

实际重建要求 Bridge 使用 `routing` 模式，并且 Core 设置
`METABOT_MEMORY_ROUTING_REBUILD_ENABLED=true`。重建使用 CAS，写入 `indexer` 事件，
并保留有界快照历史。`full` 中的路由重建仍由 Core 独立门禁控制；路由门禁关闭时，
不会阻断安全的状态处理。

停止 P5 时，将 `METABOT_MEMORY_INDEX_AUTOMATION=off`（或任一 P5 门禁设为 `false`），
然后执行常规受保护重启。这不会自动撤销已写入的项目行。单条回滚时，查看
`memory-status-full` 处理记录，用当前文档版本通过 CAS 恢复 `previous_row`，并保留处理记录作为审计轨迹。

目录移动/删除级联会转义路径中的 SQL 通配符。事件处理拒绝越过 feed head 的游标；
至少存在一个持久 consumer checkpoint 后，事件清理才允许执行。清理只删除有界 outbox 载荷，
保留处理审计记录。

## 路径与共享

路径只负责组织文档，不会授予访问权限。新写入默认位于自己的
`/users/<owner>/...` 命名空间。只有 `shared=true` 的文档才能被其他 Agent 读取：

```bash
metabot memory visibility private   # 新文档默认私有
metabot memory create "私有笔记" "..." --no-share
metabot memory share <document-id> on
```

不要把凭证、设备码或授权链接写入共享 Memory。

## 连接配置

个人版 CLI 默认连接本地 Core：

```bash
export METABOT_CORE_URL=http://localhost:9200
export METABOT_CORE_TOKEN="$(head -n 1 ~/.metabot-core/token)"
```

Token 文件权限为 `0600`，不要把它输出到日志或文档中。

## 可选 Wiki 同步

用户自行配置的飞书/Lark 部署可以把选定 Memory 内容同步到 Wiki。该能力是可选项，
个人版运行不依赖它。详见 [Wiki 同步](wiki-sync.md)。
