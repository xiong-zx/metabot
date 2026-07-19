# 交接：重启后验证 claude-engine MCP 工具修复

> 写于 2026-07-19，重启 metabot 服务前。写这份文件的会话会被这次重启销毁，
> 所以验证必须由重启后的新会话（或用户）完成。验证完请更新本文件顶部状态。

**当前状态**：`待验证` — 代码已部署到 `dev` 并推送，服务重启后生效，但端到端尚未验证。

## 修的是什么

claude-engine 的 bot 完全没有 metabot 的 MCP 工具（`worker_dispatch` / `remind_me` /
`stop_auto_remind` 全部缺失），codex-engine 的 bot 正常。两处独立的静默缺口：

1. `persistent-executor.ts` 逐字段构造 `ptyOptions` 时漏抄了 `mcpServers`。SDK 分支经
   `queryOptions` 拿得到；PTY 分支（所有 claude-engine bot 实际运行的路径）拿到 `undefined`。
2. 即使转发过去也无处落地：claude CLI 不从 `--settings` 文件读 MCP servers，只认
   `--mcp-config` / `.mcp.json` / `~/.claude.json`。而 `~/.claude/settings.json` 里的
   `mcpServers` 是 metabot 自己的约定（由 `loadMcpServersWithApiContext` 解析），
   claude 本身看不见它。codex 正常是因为它读 `~/.codex/config.toml`，完全不经过 metabot。

改法：`persistent-executor` → `PtyQueryOptions` → `hookBridge.writeMcpConfig()` →
`claude --mcp-config <file>`。刻意不加 `--strict-mcp-config`（那会屏蔽其他所有 MCP 来源，
把用户自己的 claude.ai connectors 一并干掉）。

## 已经验证过的部分（不用重做）

- **CLI 机制**：手工起真实 `claude --mcp-config <file> --permission-mode auto --print`，
  20 个 `mcp__worker-manager__*` 工具全部注册成功。
- **三跳传递单测**：`tests/persistent-executor-mcp.test.ts`（executor → ptyOptions）、
  `tests/pty-query-mcp-config.test.ts`（ptyQuery → writeMcpConfig → session）、
  `tests/pty-session-mcp-config-arg.test.ts`（session → argv）。
  反证做过：撤销 src 改动后三个正向用例各红一个。
- **合并后**：`npx tsc --noEmit` exit=0；33 个测试文件 107 个测试全绿。

## 还没验证的：端到端（← 这就是你要做的）

### 验证步骤

在**任意 claude-engine 的 bot 会话**里问一句：

> 列出你当前可用的、所有以 mcp__ 开头的工具名。

**通过标准**：出现 `mcp__worker-manager__worker_dispatch`、`mcp__worker-manager__remind_me`、
`mcp__worker-manager__stop_auto_remind` 等（完整应有 20 个）。

**失败的话**先查这些：

```bash
# 1. 实际起的 claude 进程有没有带上 --mcp-config
ps aux | grep '[c]laude --resume' | head -3

# 2. 生成的配置文件长什么样（hook bridge 的临时目录）
ls -la /tmp/metabot-pty-*/mcp-config.json && cat /tmp/metabot-pty-*/mcp-config.json

# 3. metabot 有没有解析出 servers
grep -n "loadMcpServersWithApiContext" src/engines/claude/persistent-executor.ts
```

### 验证通过之后要做的事

1. **合并 PR #6 到 `main`，必须用 merge commit，不能 squash**：

   ```bash
   GH_HTTP_TIMEOUT=30 gh pr merge 6 --merge
   ```

   原因（已实测验证）：本仓库 PR #3/#4/#5 都是 squash 合的，main 历史线性。但 `dev` 已经
   通过 merge commit `19dab7c` 含有 `ba42ebf`。如果 PR #6 走 squash，main 会拿到一个**新
   sha** 装同样的改动，`ba42ebf` 不是 main 的祖先，之后 `main → dev` 回流会在
   `pty-session.ts` 冲突。走 merge commit 则 `ba42ebf` 是 main 祖先，回流实测干净。

2. 回流 `main → dev`，保持 dev 是超集。

3. 更新 MetaMemory：`Git Branch Status`（247f6c5c-dcaf-46f9-a315-e968ce82aefa）和
   `MetaBot Small Updates`（ac0086ea-3305-4062-8229-f15210b59d62）里这条记录的状态
   从 `待验证` 改成 `完成`。

4. 删除本文件。

## 相关 commit / 分支

| 项 | 值 |
| --- | --- |
| 修复分支 | `fix/pty-mcp-config` @ `ba42ebf`（从 `origin/main` `6b346e6` 切出） |
| PR | #6 → `main`，8 文件 +335/-0，**开着，等验证** |
| dev 合并点 | `19dab7c` parents=`[055f80c ba42ebf]`，已推送 `origin/dev` |
| 冲突解法 | `pty-session.ts` 里 `--mcp-config` 块 + dev 的 root `--permission-mode auto` 分支，两边都保留 |
