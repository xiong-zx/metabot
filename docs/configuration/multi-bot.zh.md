# 多 Bot 模式

在一个 MetaBot Bridge 中运行多个飞书/Lark、Telegram、Slack 和微信 Bot。每个 Bot
拥有独立的渠道凭证、引擎、工作区、会话和群回复设置。

## 配置

在 `.env` 中设置 `BOTS_CONFIG=./bots.json`：

```json
{
  "feishuBots": [
    {
      "name": "codex-dev",
      "engine": "codex",
      "feishuAppId": "cli_xxx",
      "feishuAppSecret": "...",
      "defaultWorkingDirectory": "/home/me/project-a",
      "codex": {
        "reasoningEffort": "high"
      }
    },
    {
      "name": "kimi-reviewer",
      "engine": "kimi",
      "feishuAppId": "cli_yyy",
      "feishuAppSecret": "...",
      "defaultWorkingDirectory": "/home/me/project-b",
      "kimi": {
        "thinking": true
      }
    }
  ],
  "telegramBots": [
    {
      "name": "personal-codex",
      "engine": "codex",
      "telegramBotToken": "123456:ABC...",
      "defaultWorkingDirectory": "/home/me/personal"
    }
  ],
  "slackBots": [
    {
      "name": "slack-codex",
      "engine": "codex",
      "slackBotToken": "xoxb-...",
      "slackSigningSecret": "...",
      "defaultWorkingDirectory": "/home/me/slack-workspace"
    }
  ]
}
```

## 通用 Bot 字段

| 字段                        | 必填 | 默认值        | 说明                                      |
| --------------------------- | ---- | ------------- | ----------------------------------------- |
| `name`                      | 是   | —             | 稳定的 Bot 标识                           |
| `defaultWorkingDirectory`   | 是   | —             | Agent 可访问的工作区                      |
| `engine`                    | 否   | `"codex"`     | `"codex"`、`"kimi"` 或兼容引擎 `"claude"` |
| `model`                     | 否   | 引擎默认      | Session 模型覆盖                          |
| `visible`                   | 否   | `true`        | 是否注册到 Agent Bus 供发现               |
| `memoryPublic`              | 否   | 粘性/默认策略 | 显式设置时固定 Bot 的默认 Memory 可见性   |
| `workerTools`               | 否   | `false`       | 为非团队 `pm`/`user` 会话启用 Worker Runner 能力 |
| `mcpServers`                | 否   | `[]`          | 为该 Bot 启用独立安装的外部 MCP 产品       |
| `maxTurns` / `maxBudgetUsd` | 否   | 不限制        | Claude 兼容限制                           |
| `outputsBaseDir`            | 否   | 用户临时目录  | 自动回传到聊天的文件目录                  |

渠道凭证字段：

| 渠道      | 字段                                                                           |
| --------- | ------------------------------------------------------------------------------ |
| 飞书/Lark | `feishuAppId`、`feishuAppSecret`，可选 `feishuDomain`（`feishu` 或 `lark`）和 `groupNoMention` |
| Telegram  | `telegramBotToken`                                                             |
| 微信      | 可选 `wechatBotToken`；省略时扫码登录                                          |
| Slack     | `slackBotToken`、`slackSigningSecret`，可选 `slackBotUserId`、`groupNoMention` |

## Codex RulesPack 共享默认值

在 `bots.json` 根级配置 `rulesPackDefaults` 后，所有渠道中当前及未来新增的
Codex Bot 都会继承它。`dbPath` 必须同时包含 `{surface}` 和 `{bot}`，以隔离
Bridge、Worker 及各 Bot 的状态。`required` 默认值不允许 Bot 退出或替换必需
source；`optional` 默认值允许设置 `"rulesPack": false`，但必须同时提供
`rulesPackOptOutReason`。Claude 和 Kimi 引擎仍可使用，但 RulesPack 状态会明确
显示为 `unsupported`，因为规则注入仅支持 Codex。详见
[Codex RulesPack](../features/rulespack.md)。

如果一个 project 对应多个 chat，请用 `projectChatBindings` 列出精确的
`(bot, chatId)`。凡是声明为该 project scope 的 Rule，都会自动适用于这些
chat。用于 peer 和 Agent Bus 路由时，目标 Bridge 只发布这些精确 tuple 的
SHA-256 key 及 project ID，不会在发现结果中暴露原始 chat ID；接收端仍会用
本地配置重新验证 project。Rule target 中，同一个列表里的值是“任意一个即可”（例如 bot 是 `pm`
或 `pm-savio`）；不同字段则必须“同时满足”（例如 bot 命中上述列表，并且
认证角色包含 `pm`）。

同一 Bridge 的全部 Bot 共用一个 Core credential，因此也必须共用同一个
`dispatch.issuer`。请使用 Bridge 实际使用的 token 运行 `metabot agents whoami`，
把返回的 `botName` 原样填入 `dispatch.issuer`；不要在 `issuer` 或
`allowedIssuers` 中使用 `{bot}` / `{surface}`。旧版模板化身份配置会在启动时
给出明确迁移错误，不会静默弱化传输身份绑定。
静态 scoped peer 还应把 `peers[].auth.sourceBot` 设置为发送 Bridge 上一个
明确的本机 Bot。这个本机 dispatcher 与共享的 RulesPack transport issuer
是两个不同身份。

## Codex 配置

```json
{
  "engine": "codex",
  "codex": {
    "model": "gpt-5.6-sol",
    "profile": "personal",
    "reasoningEffort": "high",
    "approvalPolicy": "never",
    "sandbox": "workspace-write"
  }
}
```

常用字段包括 `model`、`profile`、`apiKey`、`baseUrl`、
`reasoningEffort`、`approvalPolicy`、`sandbox`、`executable`、`extraArgs`
和 `env`。普通订阅场景只需执行 `codex login`。

公开版当前运行 `codex exec --json`，通过 `codex exec resume` 续接。Codex
app-server 和原生执行中 steering 不属于当前公开行为。

## Kimi Code 配置 {#kimi-code-options}

```json
{
  "engine": "kimi",
  "kimi": {
    "model": "kimi-code/k3",
    "thinking": true,
    "permissionMode": "auto",
    "serverUrl": "http://127.0.0.1:58627"
  }
}
```

| 字段                  | 默认值                   | 说明                                        |
| --------------------- | ------------------------ | ------------------------------------------- |
| `kimi.model`          | Kimi Code 配置默认       | 模型 ID 或已配置的短别名                    |
| `kimi.thinking`       | Kimi Code 配置默认       | Thinking 覆盖                               |
| `kimi.permissionMode` | `auto`                   | 工具权限策略；`yolo` 仅限可信工作区显式启用 |
| `kimi.executable`     | `PATH` 中的 `kimi`       | Kimi Code 可执行文件                        |
| `kimi.serverUrl`      | `http://127.0.0.1:58627` | 已有 loopback Server 地址；否则按需启动     |
| `kimi.contextWindow`  | 当前 Kimi 默认           | 展示/上下文覆盖                             |

Kimi 需要 Kimi Code 0.27+：

```bash
npm install -g @moonshot-ai/kimi-code@latest
kimi login
```

MetaBot 使用与 Kimi Web 前端同源的官方本地 Server API，支持持久 Session、
原子快照、问题交互、停止、用量、工具、子 Agent 和 Goal。本版本暂不开放
飞书执行中 steering，也不再使用旧 Python `kimi-cli --wire --work-dir` 协议。

`permissionMode` 默认是 `auto`。只有在完全可信的工作区中才应显式选择
`yolo`；个人版不会默认开启该模式。

## Claude Code 兼容

现有 Bot 可以设置 `"engine": "claude"`，继续使用 Claude 登录、Anthropic
兼容 Provider、`.claude/skills/` 和 `CLAUDE.md`。个人版新 Bot 省略
`engine` 时默认为 Codex。

## 运行行为

- 每个 Bot 拥有独立渠道连接和工作区。
- 会话按 Bot 和 `chatId` 隔离。
- Chat 可以使用 `/model` 切换引擎/模型，不会改变 Bot 身份。
- 飞书群回复模式按 Bot 和群持久化。
- Agent Teams 和 Agent Bus 可以协调不同引擎的 Bot。
- 环境变量提供默认值；显式 `bots.json` 字段优先。
- `workerTools` 保留 Worker Runner 的 Bridge 会话授权。ARC、MetaClaw、
  Zotero 等产品通过每个 Bot 的 `mcpServers` descriptor 使用独立安装命令和
  产品自己的配置。Codex 使用单次调用配置，Claude 使用追加式会话配置，
  都不会覆盖用户共享的 MCP 设置。
- 所有渠道的 Bot 名称在 Unicode 规范化及忽略大小写后必须全局唯一；这也
  能避免大小写不敏感文件系统上的每 Bot 状态路径碰撞。

设置 `BOTS_CONFIG` 后，单 Bot 的渠道环境变量会被忽略。

## 单 Bot 模式

未设置 `BOTS_CONFIG` 时，通过环境变量配置一个 Bot：

```bash
METABOT_ENGINE=codex
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=...
CLAUDE_DEFAULT_WORKING_DIRECTORY=/home/me/project
```

Slack 单 Bot 模式：

```bash
METABOT_ENGINE=codex
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
CLAUDE_DEFAULT_WORKING_DIRECTORY=/home/me/project
```

`CLAUDE_DEFAULT_WORKING_DIRECTORY` 保留了历史名称，但会为所有引擎提供工作区。

完整列表见[环境变量](environment-variables.md)。
