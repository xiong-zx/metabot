<!-- METABOT-WORKER -->

# Worker Agent 规范

本规范只适用于由 PM agent、user 或 admin 明确派发的 Worker 任务。Worker 专注完成被分配的任务。

普通 bot 对话、轻量问答、记忆整理、说明原因、讨论方案等场景中，当前执行者仍是 bot，不应自动套用 Worker 的 `results.json`、`worker-progress.json` 和 `RESULT:` 最后一行输出要求，除非用户或 PM 明确要求按 Worker 任务执行。

## 规则

- GPU 训练：先 `nvidia-smi` 找空闲 GPU，用 `CUDA_VISIBLE_DEVICES` 指定
- 特征构建：NumPy/Pandas 向量化，禁止 Python for 循环
- 安装依赖前先检查：`python3 -c "import xxx" 2>/dev/null || pip install xxx -q`
- 训练日志写入 workdir/train.log
- 所有实验必须用 WandB 记录：`wandb.init(project="<项目名>", entity=os.environ["WANDB_ENTITY"])`（entity 以环境变量 `WANDB_ENTITY` 或 PM 指令中给出的为准）
- Git commit 所有代码改动;**提交前按下方「Git 分支工作流」选对分支**,不同工作流不要混进同一个 commit
- 下载大数据集/模型用学术加速：`bash -c 'source /etc/network_turbo && <命令>'`（仅在该脚本存在的服务器上）
- 获得稳定结论/踩坑经验时，更新本 workdir 的 `AGENTS.md`（项目级记忆：环境配置、数据路径、坑、约定，供后续 worker 与 PM 复用）；不要删除其中已有内容

## Git 分支工作流（提交前必读）

本仓库按工作流分支，**提交前先选对分支**，别把不同工作流混进同一个 commit：

| 分支               | 用途                                                                                        | 谁往这提交                      |
| ------------------ | ------------------------------------------------------------------------------------------- | ------------------------------- |
| `main`             | 稳定/发布分支，只经 PR 合入，历史干净                                                       | 不直接提交                      |
| `feat/agent-team`  | agent team / template 相关开发                                                              | team / template 任务            |
| `feat/memory-core` | memory core + auto research（两者**不拆**，同一条），当前 stacked 在 `feat/agent-team` 之上 | memory / auto-research 任务     |
| `fix/<描述>`       | 日常小 bug，短命分支，修完尽快合                                                            | 单个 bug 修复                   |
| `dev`              | 集成 + 部署分支：多 feature 合一起跑 live 服务；不对外 PR、不追求干净历史                   | 只做集成/联调，别在这开发新特性 |

规矩：

- 一个 commit 只做一件事；memory 的活别碰 agent-team 的文件，反之亦然。
- **禁止**直接往 `main` 提交；**禁止** rebase / force-push 任何共享分支（`dev`、已推送的 `feat/*`）。
- 要跑 live 验证 → 把 feature 分支合进 `dev`；要评审 / 进 `main` → 从 feature 分支开 PR。
- feature 分支从 `main` 拉；若新工作依赖别的 feature（如 memory-core 依赖 agent-team），就 stack 在那条 feature 上，别硬拆成独立分支。
- 非平凡 merge 后不能只看 conflict 文件；必须分别对两个 parents 做 semantic loss sweep，至少比对 test-name inventory 和 exported/declaration symbol inventory。可先用 `git diff --name-only <parent> HEAD -- tests src packages | rg '^(tests|src|packages)/.*\.ts$'` 取文件，再用 `rg -n "^\\s*(it|test)\\("` 与 `rg -n "^\\s*export\\s+(function|class|const|type|interface|enum)|^\\s*(function|class|const|type|interface|enum)\\s+"` 生成 parent/merge 清单后 `comm -23`；任何丢失都要补回或在 commit 说明中解释，因格式换行产生的符号假阳性也必须逐项核验并记录。

## MetaBot 重启安全

标准调用形式（改完 `src/` 让 bridge 生效时用这个，不要自己拼 `pm2`）：

```bash
metabot restart --wait --json --resume \
  --reason "<为什么重启>" --source pm --bot <botName> --chat <chatId>
```

裸 `pm2 restart metabot` 也能起来，但会跳过 tsx 依赖预检（`_ensure_runtime_deps`）、重启面包屑（`_write_restart_breadcrumb`）、requestId 原子 claim 和 `restart-requests.json` 审计台账——**看起来成功，实则失去保护**。其中面包屑缺失会让被 `--resume` 恢复的 agent 重新读到"请重启"并再次重启，形成循环。

重启会杀掉 bridge 的所有子进程，包括发起重启的那个会话本身；会话随后由 `--resume <sessionId>` 从 JSONL 恢复历史，**对话看起来毫无断裂但进程已全换**，不要据此判断"重启没发生"。

- MetaBot 自身启动的 Bot、Agent、Worker、Codex、Claude 或 shell 子进程，禁止执行或建议 `pm2 delete metabot` / `pm2 stop metabot` 后再 `pm2 start ...`。第一步会杀死执行第二步的进程树。
- 同一 runtime 的普通重启只使用 `metabot restart`（底层为单次 `pm2 restart metabot --update-env`）。不得把 `pm2 save` 放在旧进程的重启 shell 中；由新进程健康检查通过后保存 PM2 状态。
- 切换 cwd/script/worktree 必须从 MetaBot 进程树之外的 SSH、supervisor 或独立部署控制器执行 `metabot deploy-runtime --runtime <dir>`。该命令在内部调用时必须 fail closed。
- 恢复 turn 收到已有 restart requestId/breadcrumb 后，只做健康检查、验收和剩余工作；同一 requestId 不得再次触发实际重启。

## 结果输出

仅在明确 Worker 任务中，完成后将结果写入 workdir/results.json，格式根据任务类型自定：

```json
{"task": "简述任务", "metrics": {"<指标名>": <数值>, ...}, "notes": "关键发现"}
```

## 进度上报

仅在明确 Worker 任务中，定期更新 workdir/worker-progress.json:

```json
{ "status": "running", "step": "当前步骤描述", "metrics": {}, "timestamp": "ISO8601" }
```

## Worker 返回格式

仅在明确 Worker 任务中，完成后最后一行输出：

```
RESULT: task=[简述] metrics={<指标名>=<数值>, ...} notes=[简短说明]
```

普通 bot 对话不要输出 `RESULT:` 行。

## 项目环境备注

- 若 `npm ci` 在 `node-pty` / `node-gyp` 阶段下载 `node-v*-headers.tar.gz` 因 `SELF_SIGNED_CERT_IN_CHAIN` 失败，优先使用本机 Node 头文件绕过下载：`npm_config_nodedir=/usr npm_config_strict_ssl=false npm ci`。本环境已验证 `/usr/include/node` 可用。
- 2026-07-05 启动 bridge 服务时发现全局 `pm2` 缺失；项目 CLI `metabot start/status/logs` 依赖 `pm2`，可先 `command -v pm2 || npm install -g pm2 -q`，再执行 `metabot start`。本环境验证后 bridge 监听 `0.0.0.0:9100`，core 服务监听 `127.0.0.1:9200`。
- 2026-07-05 飞书长连接连不上时，日志若出现 `The plain HTTP request was sent to HTTPS port` 或 `tenant_access_token ... undefined`，优先检查 PM2 进程继承的代理环境。`open.feishu.cn`、`*.feishu.cn`、`lark.larksuite.com`、`*.larksuite.com` 需要在 `NO_PROXY/no_proxy` 中绕过代理；已在 `ecosystem.config.cjs` 固化。同 runtime 修改后用 `metabot restart --wait`，切换 runtime 则从外部控制器执行 `metabot deploy-runtime --runtime <dir>`。
- 2026-07-07 轻量 AutoResearchClaw 验证时，memory ingest artifact 必须写到项目根下 `.metabot-memory/autoresearchclaw/<run-id>-output.json`，且 `artifacts[].uri` 只能引用项目根内路径；规划型 dry run 可将不确定结论放入 `memory_event_candidates`，并将最终长期记忆改为 review/staging 流程处理。
- 2026-07-15 MetaMemory → 飞书知识库同步当前限定在 `METABOT_CORE_MEMORY_SERVER_ROOT=/cargo1`；希望出现在飞书 `MetaMemory` 知识空间的文档必须放在 `/cargo1` 下并标记 `shared:true`。曾把 ToDo 写到 `/metabot/todo` 导致飞书侧不可见，已移动到 `/cargo1/todo/metabot-todo-registry` 并通过 `/api/sync/document` 同步成功。
- 2026-07-16 做 live preflight 时确认：根目录 `npm test` 会把 sibling `worktrees/*` 一起纳入 Vitest 搜索，并把 `spike/*.test.ts` 这类无 `describe/it` 的实验文件当成失败用例；做发布前 gate 时优先直接运行聚焦的 `npx vitest run <file...>` 文件列表，不要把根 `npm test` 当成 Agent Team live 验证门禁。
- 2026-07-21 MEM-009 修复后，WorkerManager 对 `autoresearchclaw_output_v2` artifact 必须复用 `validateAutoResearchClawOutput` 深度校验；contract-invalid artifact 只能是 `artifactStatus=invalid` / `contractStatus=violated`，并在 `artifactError.code/message` 暴露原因，不能从失败 worker 恢复为 completed。Legacy candidate aliases 只在受控兼容路径归一化并发出 deprecation telemetry。
- 2026-07-21 MEM-010/FIX-003：`/api/talk/:taskId` 终态 AutoResearchClaw 只把 `currentPhase` 标成 `completed`/`failed`，ingest/review 结果必须作为 Memory Core system-of-record 后续查询元数据呈现；`bin/metabot` 解析 feature CLI 时，source-tree launcher 必须有 `packages/cli/dist/index.js` 才算 ready，`METABOT_DEFAULT_ENV_FILE` 可指向 ready checkout 复用 CLI，env 文件和 PATH/显式 CLI symlink 会先 canonicalize 再做 ready check，但显式坏的 `METABOT_CORE_CLI` 必须 fail-closed。`set -e` 下 `_load_core_cli_config` 在缺少可选 token 时也要显式 `return 0`，否则 delegate 会提前退出。
