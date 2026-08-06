# 下游 Fork 维护流程

## 状态

| 字段         | 内容                       |
| ------------ | -------------------------- |
| 状态         | 生效中                     |
| 负责人       | 下游维护者                 |
| 上游         | `xvirobotics/metabot:main` |
| 下游发布分支 | `origin/main`              |
| 集成规则     | 通过审查 PR 合并 upstream  |

本仓库完整保留 upstream 历史，只增加一小组明确批准的功能，不会把旧
fork 的历史提交逐个重新搬运。保留功能及依赖边界记录在结构化文件
`config/downstream-features.json` 中，可由 CI 直接检查。

## 定期同步

`Prepare upstream sync` 工作流每周运行一次，也可以手动启动。它会获取
`upstream/main`、按 upstream 提交号创建同步分支、执行普通 Git merge，
然后在规定的 Node 版本中安装依赖，运行边界检查、测试和构建，最后创建
PR。它不会直接提交到 `main`，也不会自动猜测冲突的解决方法。

如果 merge 发生冲突，下载工作流产生的冲突报告，在本地创建普通的
`sync/upstream-*` 分支。除非批准保留的功能确实需要，否则优先保持
upstream 行为。核心 hook 经常冲突，说明 hook 应继续缩小，而不是整份
复制 upstream 文件。

## 增删下游功能

1. 从 `main` 创建聚焦的 `feat/*` 或 `fix/*` 分支。
2. 在 `config/downstream-features.json` 中新增或修改一个条目。
3. 新状态机优先放进独立 package；只有必须接入 upstream runtime 时才加
   小型 hook。
4. 运行 `npm run check:downstream-boundaries`、聚焦测试和完整 CI 门禁。
5. 只通过 PR 合并。删除功能后，也要删除对应清单条目，并确认旧路径和
   禁止依赖没有残留。

`planned` 表示迁移期间暂未强制要求该路径存在。upstream-first 版本发布
前，所有决定保留的模块都必须改成 `required`；仍为 `planned` 就不能发布。
`npm run check:downstream-boundaries:release` 会强制执行这条规则，定期同步
upstream 的工作流也使用这个严格模式。

GitHub 仓库的 Actions 设置必须允许工作流创建 PR。如果没有打开该权限，
工作流仍会推送已验证的同步分支，再由维护者手动创建 PR。

## 发布检查

发布前确认：`upstream/main` 是候选 merge commit 的祖先；功能边界检查
通过；所有 `required` 路径存在；旧实现路径不存在；外部用户规则没有被
安装或更新覆盖；并且功能已经在一次性 `dev` runtime 中通过 live E2E。
