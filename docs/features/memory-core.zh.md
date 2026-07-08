# Memory Core

Memory Core 是 MetaBot 的执行级记忆系统。它面向 agents 和 workers，不是普通笔记库。它的目标是把科研和工程过程中真正会影响后续行动的经验从 prompt 里剥离出来，变成可检索、可审计、可压缩、可跨项目复用的系统资产。

## 它和 MetaMemory 的区别

| 系统                 | 面向谁         | 保存什么                                                                  | 是否进入执行关键路径         |
| -------------------- | -------------- | ------------------------------------------------------------------------- | ---------------------------- |
| Research Memory Core | Agent / worker | facts、decisions、negative results、constraints、open questions、evidence | 是，会生成 context pack      |
| MetaMemory           | 人类和 Agent   | Markdown 总结、周报、蓝图、会议纪要、说明文档                             | 否，主要用于阅读和知识库同步 |
| 项目本地文件         | 当前项目       | `AGENTS.md`、`CLAUDE.md`、稳定规则、路径约定                              | 是，但应短小稳定             |

一句话：Memory Core 是机器执行记忆，MetaMemory 是人类知识文档。

## 核心对象

Memory Core 只有两个执行对象和一个输出对象：

| 对象         | 说明                                                                   |
| ------------ | ---------------------------------------------------------------------- |
| Memory Event | append-only 原始记忆事件。记录谁在什么时候基于什么证据写入了什么结论。 |
| Memory Unit  | curator 从 events 中提炼出的可检索、可注入上下文的短记忆。             |
| Context Pack | 针对某次任务、在 token budget 内生成的运行上下文。                     |

事件不会被物理改写。过时、错误或敏感内容通过 `supersede` / `redact` 追加 tombstone 处理，保留审计链。

## Scope 和状态

记忆有四种可见范围：

| scope   | 用途                      |
| ------- | ------------------------- |
| private | 单个 actor 或局部尝试可见 |
| project | 当前项目可复用            |
| domain  | 同一领域多个项目可复用    |
| global  | 全系统高置信通用原则      |

直接写入只允许 `private` / `project`。`domain` / `global` 必须走 promotion 审批。

状态包括：

| 状态           | 说明                          |
| -------------- | ----------------------------- |
| candidate      | 候选记忆，等待 review         |
| active         | 默认可用于搜索和 context pack |
| pending_review | 等待审批                      |
| rejected       | 已拒绝，不进入默认检索        |
| superseded     | 被更新结论替代                |
| redacted       | 已脱敏，不进入默认检索        |

## 飞书端怎么用

普通用户不需要知道 MCP 工具名，也不需要输入命令行。直接在飞书里告诉 `research-pm` / `admin` 你要做什么。

### 记录项目记忆

```text
把这个结论记入 proj-alpha 的 project memory：
AutoResearchClaw worker 只能产出结构化 JSON，不能直接写长期记忆。
证据：今天 run-smoke-1 的输出校验通过。
```

术语说明：用户可以自然地说“fact / 事实”，但 append-only event type 里表示可验证事实类观察的是 `finding`。CLI 和 MCP 接受 `fact` 作为 shorthand，并映射成 `finding`；context pack 里的 memory unit 仍可以用 facts 这个人类友好的说法展示。

### 搜索记忆

```text
检索 proj-alpha 里和 negative result / token budget 相关的记忆。
请只返回 active 记忆，并带上 memory id 和 evidence。
```

### 生成 context pack

```text
为这个任务生成 context pack：
我要继续优化 AutoResearchClaw 的 ingest 校验。
projectId=proj-alpha，domain=metabot，token budget 3000。
请说明哪些记忆被纳入，哪些因为 scope/status 被排除。
```

### 查看候选记忆

```text
列出 proj-alpha 当前 candidate memory。
按风险排序：先看可能会影响后续 worker 行为的结论。
```

### 提升跨项目记忆

```text
这条 project memory 看起来适用于整个 metabot domain。
请发起 promotion request，并列出证据、风险和建议 scope。
等我批准后再提升。
```

批准：

```text
批准这个 promotion request，提升到 metabot domain。
理由：它已经在两个项目里被独立验证。
```

拒绝：

```text
拒绝这个 promotion request。
理由：证据不足，只能保留在当前 project。
```

### 替换或脱敏记忆

```text
用新的结论 supersede 旧 memory：
旧结论说 full history injection 是默认方案；
新结论是 context pack 是默认方案，full history 只用于人工审计。
```

```text
redact 这条 memory。它包含不该进入 context pack 的本地敏感路径。
```

## 自动写入规则

AutoResearchClaw worker 完成后，系统会读取结构化输出，并把这些内容交给 curator：

- hypotheses
- experiments
- findings
- negative_results
- decisions
- artifacts
- open_questions
- metrics

curator 会做：

- 校验 contract 和 artifact 路径。
- 把可追溯结论变成 memory events。
- 把适合复用的结论压缩成 memory units。
- 把不确定内容放到 candidate / review。
- 拒绝 worker 直接写入 domain/global。

## Context Pack 规则

Context pack 是 Memory Core 最重要的运行产物。它不是把历史全部塞进 prompt，而是在 token budget 内选择最相关、最可信的记忆。

默认优先级：

1. 当前项目的 active decisions / constraints / negative results。
2. 当前项目与任务强相关的 findings / open questions。
3. 同 domain 的高置信 promoted memory。
4. 少量 global memory。

默认排除：

- rejected
- redacted
- superseded
- 未明确要求时的 candidate
- scope 不匹配的 private/project memory

你可以在飞书里要求：

```text
生成 context pack 时包含 candidate memory，但请单独标注，不要当作事实使用。
```

## 证据和可追溯性

每条有效记忆都应该能追溯到：

- source event id
- evidence event id
- run id
- artifact URI
- actor
- scope
- confidence 或 review 状态

如果 Bot 给出的记忆没有证据，可以要求：

```text
不要只给结论。请展开这条 memory 的 evidence chain：
source event、run id、artifact 和创建 actor。
```

## 权限和防污染边界

Memory Core 的安全边界：

- 飞书端发来的普通请求不能绕过 allowlist 访问任意 root。
- worker 不能直接写长期跨项目记忆。
- AutoResearchClaw 输出必须通过 contract 校验。
- 本地 artifact URI 必须位于 project root 内。
- domain/global promotion 需要用户或系统管理员审批。
- redaction 和高影响 supersede 会保留审计记录。

这些限制是为了防止一次错误实验污染未来所有项目。

## 什么时候该写 memory

适合写入：

- 多次会话都可能需要复用的项目约束。
- 有证据支持的实验发现。
- 明确失败的方法和失败原因。
- 用户确认的架构决策。
- 会影响后续 worker 行为的偏好或规则。

不适合写入：

- 临时聊天寒暄。
- 没有证据的猜测。
- 大段日志原文。
- 未脱敏的 secret、token、私有路径。
- 只对当前回复有用、未来不会复用的信息。

如果不确定，可以让 Bot 先作为 candidate 记录：

```text
这条信息可能值得记忆，但我还不确定。
请先作为 candidate memory 保存，等后续 run 验证后再决定是否 active。
```

## 相关文档

- [自动科研系统](auto-research.zh.md)
- [MetaMemory](metamemory.zh.md)
- [Agent 团队](agent-teams.zh.md)
