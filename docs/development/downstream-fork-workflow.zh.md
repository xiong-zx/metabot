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
然后在规定的 Node 版本中安装依赖，运行迁移阶段的边界检查、测试和构建，
最后创建 PR。它不会直接提交到 `main`，也不会自动猜测冲突的解决方法。
手动运行只能从 `main` 启动。

合入的 upstream 代码在检查通过前视为不可信。验证 job 因此只有仓库和 PR
的只读权限，checkout 也不保存写入凭据。验证完成后，它把 Git bundle
（一个只含候选提交的 Git 文件）交给独立且最小化的发布 job。发布 job
可以推送分支和创建 PR，但不会安装依赖或执行合并后代码。

每个 upstream 提交对应固定的同步分支名。如果该分支或打开的 PR 已存在，
自动化会保持原样，避免覆盖人工冲突修复和审查修改。要从头重试一个已关闭
的同步 PR，维护者必须先删除或改名远端旧分支。

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
`npm run check:downstream-boundaries:release` 会强制执行这条规则，并由正式
发布工作流调用。定期同步 upstream 时使用
`npm run check:downstream-boundaries`，因此迁移尚未完成时，`planned` 模块
不会阻止生成审查 PR。

导入边界有两种字符串写法。`@xvirobotics/arc-mcp` 这样的 scoped 包名
（带 `@组织名/` 的包名），或不含 `/` 的普通包名，会按裸包名检查，并覆盖
它的子路径。`src/memory-core` 这样的条目是仓库相对路径；扫描器从导入文件
的位置解析相对导入，再按完整路径段比较，也支持 TypeScript 的
`import = require(...)`。扫描器不会解释 TypeScript `paths` 映射、package
`imports` 别名或其他自定义模块解析规则。涉及边界的导入应使用相对路径；
如果以后引入别名，应另加 lint 规则。`reverseBoundaries` 使用同样的包检查，
防止 upstream 自有目录反向依赖 downstream 包。

默认情况下，`forbiddenImports` 会扫描功能 `roots` 下的全部源码。如果一个
功能的生产代码必须保持隔离，但端到端测试需要调用另一个包的公开 API，可用
更窄的 `importRoots` 指定依赖扫描目录。每个 `importRoots` 都必须位于某个
已声明的 `roots` 内；对于 `required` 功能，所有这些目录也必须真实存在。
这不是通用豁免清单：选中生产目录里的禁止依赖仍会直接让门禁失败。

GitHub 仓库的 Actions 设置必须允许工作流创建 PR。如果没有打开该权限，
发布 job 会失败，但不会修改 `main`。维护者可在一天的保留期内下载已验证
候选 artifact（工作流产物），再手动发布审查分支。

## 发布检查

发布前确认：`upstream/main` 是候选 merge commit 的祖先；功能边界检查
通过；所有 `required` 路径存在；旧实现路径不存在；外部用户规则没有被
安装或更新覆盖；禁止路径不存在悬空符号链接；反向依赖边界通过；并且功能
已经在一次性 `dev` runtime 中通过 live E2E。
