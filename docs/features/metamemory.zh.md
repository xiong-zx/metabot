# MetaMemory

内嵌知识库，全文搜索。Agent 跨会话读写 Markdown 文档，所有 Agent 共享。

## 概述

MetaMemory 是基于 **SQLite 的文档存储**（使用 FTS5 全文搜索），为所有 Agent 提供持久化知识。

- **文档** 是 Markdown 文件，按文件夹树组织
- **全文搜索** 基于 SQLite FTS5
- **Web UI** 在 `http://localhost:8100?token=YOUR_TOKEN` 浏览和搜索
- **REST API** 程序化访问
- **CLI**（`mm`）终端访问

## 和 Memory Core 的关系

MetaMemory 是人类可读知识层，Memory Core 是 Agent / worker 的执行级记忆层。两者联动，但职责不同：

| 系统 | 保存内容 | 主要读者 | 是否作为执行关键事实源 |
|------|----------|----------|------------------------|
| MetaMemory | Markdown 蓝图、周报、会议纪要、项目说明、人工整理结论 | 人类和 Agent | 否 |
| Memory Core | 可追溯 events、memory units、负结果、决策、context pack evidence | Agent / worker | 是 |

AutoResearchClaw run 结束后，可靠事实先进入 Memory Core；给人读的摘要、阶段性报告和架构说明再发布到 MetaMemory。不要把大量实验日志或未审查事实直接写成 MetaMemory 文档来驱动后续 worker。

公开 MetaMemory API 的写入路径默认只允许 `/users`、`/shared`、`/metabot`。这防止 agent 把 Research Memory 的项目 root（例如系统路径或实验目录）伪装成 MetaMemory 文件夹。需要扩展公开写入命名空间时，显式配置 `METABOT_CORE_MEMORY_WRITE_ROOTS`。

## Agent 如何使用

Claude 通过 `metamemory` skill 自主读写知识文档。当用户说"记住这个"或 Claude 需要持久化知识时，它会调用 memory API。

```
把我们刚讨论的部署方案写入 MetaMemory，放到 /projects/deployment 下面。
```

```
搜索一下 MetaMemory 里有没有关于 API 设计规范的文档。
```

## 聊天命令

| 命令 | 说明 |
|------|------|
| `/memory list` | 浏览知识库目录 |
| `/memory search 关键词` | 搜索知识库 |
| `/memory status` | 查看 MetaMemory 状态 |

这些命令直接通过 `MemoryClient` HTTP 客户端响应，无需启动 Claude。

## CLI（`mm`）

```bash
# 读
mm search "部署指南"                 # 全文搜索
mm list                             # 列出文档
mm folders                          # 文件夹树
mm path /projects/my-doc            # 按路径获取文档

# 写
echo '# 笔记' | metabot memory create "标题" --share --tags "dev,team"
echo '# 更新内容' | metabot memory update DOC_ID --share --tags "dev,team"
metabot memory share DOC_ID on       # 让已有文档跨 bot 可读
mm mkdir "new-folder"               # 创建文件夹
mm delete DOC_ID                    # 删除文档
```

## Web UI 访问

配置了认证（`API_SECRET`、`MEMORY_ADMIN_TOKEN` 或 `MEMORY_TOKEN`）后，Web UI 需要 Token。通过 URL 参数传递：

```
http://localhost:8100?token=YOUR_TOKEN
```

启动日志会打印带 Token 的完整 URL。Token 会保存到浏览器的 `localStorage`，只需传递一次。也可以在 Web UI 的设置图标中设置或清除 Token。

## 访问控制

MetaMemory 支持文件夹级 ACL：

| Token | 访问权限 |
|-------|---------|
| `MEMORY_ADMIN_TOKEN` | 完整访问 — 可见所有文件夹 |
| `MEMORY_TOKEN` | 读者访问 — 仅可见 shared 文件夹 |

详见[安全](../concepts/security.md#metamemory-访问控制)。

## 配置

| 变量 | 默认 | 说明 |
|------|------|------|
| `MEMORY_ENABLED` | `true` | 启用 MetaMemory |
| `MEMORY_PORT` | `8100` | MetaMemory 端口 |
| `MEMORY_ADMIN_TOKEN` | — | 管理员 Token（完整访问） |
| `MEMORY_TOKEN` | — | 读者 Token（仅 shared） |
| `META_MEMORY_URL` | `http://localhost:8100` | MetaMemory 地址（CLI 用） |
| `METABOT_CORE_MEMORY_WRITE_ROOTS` | `/users,/shared,/metabot` | 公开 Memory API 允许创建/写入的顶层路径，逗号分隔 |

## 自动同步到知识库

MetaMemory 变更可以自动同步到飞书知识库。详见 [Wiki 同步](wiki-sync.md)。
