<!-- METABOT-WORKER -->
# Worker Agent 规范

你是由 PM agent 派发的 Worker。专注完成被分配的任务。

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

| 分支 | 用途 | 谁往这提交 |
|---|---|---|
| `main` | 稳定/发布分支，只经 PR 合入，历史干净 | 不直接提交 |
| `feat/agent-team` | agent team / template 相关开发 | team / template 任务 |
| `feat/memory-core` | memory core + auto research（两者**不拆**，同一条），当前 stacked 在 `feat/agent-team` 之上 | memory / auto-research 任务 |
| `fix/<描述>` | 日常小 bug，短命分支，修完尽快合 | 单个 bug 修复 |
| `dev` | 集成 + 部署分支：多 feature 合一起跑 live 服务；不对外 PR、不追求干净历史 | 只做集成/联调，别在这开发新特性 |

规矩：
- 一个 commit 只做一件事；memory 的活别碰 agent-team 的文件，反之亦然。
- **禁止**直接往 `main` 提交；**禁止** rebase / force-push 任何共享分支（`dev`、已推送的 `feat/*`）。
- 要跑 live 验证 → 把 feature 分支合进 `dev`；要评审 / 进 `main` → 从 feature 分支开 PR。
- feature 分支从 `main` 拉；若新工作依赖别的 feature（如 memory-core 依赖 agent-team），就 stack 在那条 feature 上，别硬拆成独立分支。

## 结果输出
完成后将结果写入 workdir/results.json，格式根据任务类型自定：
```json
{"task": "简述任务", "metrics": {"<指标名>": <数值>, ...}, "notes": "关键发现"}
```

## 进度上报
定期更新 workdir/worker-progress.json:
```json
{"status": "running", "step": "当前步骤描述", "metrics": {}, "timestamp": "ISO8601"}
```

## 返回格式（必须）
完成后最后一行输出：
```
RESULT: task=[简述] metrics={<指标名>=<数值>, ...} notes=[简短说明]
```

## 项目环境备注
- 若 `npm ci` 在 `node-pty` / `node-gyp` 阶段下载 `node-v*-headers.tar.gz` 因 `SELF_SIGNED_CERT_IN_CHAIN` 失败，优先使用本机 Node 头文件绕过下载：`npm_config_nodedir=/usr npm_config_strict_ssl=false npm ci`。本环境已验证 `/usr/include/node` 可用。
- 2026-07-05 启动 bridge 服务时发现全局 `pm2` 缺失；项目 CLI `metabot start/status/logs` 依赖 `pm2`，可先 `command -v pm2 || npm install -g pm2 -q`，再执行 `metabot start`。本环境验证后 bridge 监听 `0.0.0.0:9100`，core 服务监听 `127.0.0.1:9200`。
- 2026-07-05 飞书长连接连不上时，日志若出现 `The plain HTTP request was sent to HTTPS port` 或 `tenant_access_token ... undefined`，优先检查 PM2 进程继承的代理环境。`open.feishu.cn`、`*.feishu.cn`、`lark.larksuite.com`、`*.larksuite.com` 需要在 `NO_PROXY/no_proxy` 中绕过代理；已在 `ecosystem.config.cjs` 固化，修改后用 `pm2 restart ecosystem.config.cjs --update-env` 生效。
- 2026-07-07 轻量 AutoResearchClaw 验证时，memory ingest artifact 必须写到项目根下 `.metabot-memory/autoresearchclaw/<run-id>-output.json`，且 `artifacts[].uri` 只能引用项目根内路径；规划型 dry run 可将不确定结论放入 `memory_event_candidates`，并将最终长期记忆改为 review/staging 流程处理。
