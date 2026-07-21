# 自动科研系统

自动科研系统把一个科研项目拆成可监督、可恢复、可沉淀记忆的研究循环。用户在飞书端描述目标，MetaBot 负责调度 `research-pm`、内部 agents 和 AutoResearchClaw worker；worker 完成后，结构化结果会进入 Memory Core，再由 curator 决定哪些内容可以成为长期记忆。

## 适合做什么

- 文献阅读和结论对比。
- 假设生成、实验计划和代码实现。
- 执行实验、读取日志、分析指标。
- 记录负结果、踩坑、约束和关键决策。
- 周期性 refine / pivot，持续推进一个长期科研项目。

不适合把它当作普通聊天记录归档器。聊天总结应进入 MetaMemory；能影响未来 research loop 的事实、决策、负结果和项目约束才进入 Research Memory Core。

## 飞书端怎么用

在飞书里找 `research-pm`。如果当前部署没有单独配置 `research-pm`，就找具备 worker 权限的 `admin` / `manager`，并明确要求它使用 Research Memory / AutoResearchClaw 能力。

发起一次研究循环时，最好一次性给出这些信息：

| 信息         | 示例                                                           |
| ------------ | -------------------------------------------------------------- |
| project root | `/root/workspaces/proj-alpha`                                  |
| projectId    | `proj-alpha`                                                   |
| domain       | `metabot`、`biology`、`robotics`                               |
| 研究目标     | `验证 context pack 是否减少重复 prompt`                        |
| 输入材料     | 论文 URL、数据集路径、已有实验日志、代码目录                   |
| 输出要求     | 假设、实验、发现、负结果、决策、open questions                 |
| 记忆策略     | `先进入 review`、`只写 project memory`、`需要我审批 promotion` |

可以直接发送：

```text
请在 /root/workspaces/proj-alpha 启动一次 AutoResearchClaw 研究循环。
projectId 是 proj-alpha，domain 是 metabot。
目标：验证 context pack 是否能减少重复 prompt，并比较 full history injection。
请先生成 context pack，再派发 worker。
worker 产出需要包含 hypotheses、experiments、findings、negative_results、decisions、artifacts、open_questions。
记忆先进入 review，不要直接提升到 domain/global。
```

追加材料：

```text
这次研究使用 /root/workspaces/proj-alpha/results/2026-07-06.json 作为实验结果，
并参考这篇论文：[URL]。
请把数据路径和论文链接作为 evidence，不要复制大文件内容。
```

要求继续迭代：

```text
基于上一次 run 的负结果继续 refine。
请保留同一个 projectId，新的 runId 由你生成。
这次重点验证为什么 token budget 超标，并提出替代方案。
```

## 运行时会发生什么

1. `research-pm` 先读取项目规则和已有 Research Memory。
2. Memory Core 根据任务生成低 token context pack。
3. MetaBot 通过 WorkerManager 派发 AutoResearchClaw worker。
4. worker 在项目 root 下执行 research loop，并写出结构化 JSON artifact。
5. 系统校验 artifact contract、artifact 路径和 scope。
6. Memory Curator 把结果转换为 memory events / memory units。
7. 如果开启 review，结果先以 candidate 形式进入记忆，等待人工确认。
8. 可读总结进入 MetaMemory，执行关键事实留在 Research Memory Core。

启动长时间 AutoResearchClaw run 之前，bot 应该先在飞书里发一条 preflight 摘要。摘要应包括 project id / root / domain、context pack 阶段、worker dispatch 阶段、必需 output contract、ingest / review 阶段、完成标准，以及如何查看状态。

必需输出契约是 `autoresearchclaw.output.v2`，顶层字段包括：`contract_version`、`project_id`、`run_id`、`status`、`summary`、`hypotheses`、`experiments`、`findings`、`negative_results`、`decisions`、`artifacts`、`open_questions`、`memory_event_candidates`、`recommended_followups`、`tool_trace`。

嵌套字段也必须满足 schema，不能只满足顶层 key：hypotheses、findings、negative results、decisions、open questions、metrics、pivots 都需要非空 `summary`；artifacts 需要 `id`、`uri`、`summary`；tool trace 需要 `tool` 和 `summary`。每个 `memory_event_candidates[]` 项只要求受支持且非受控的 `type` 和非空 `summary`；可选 canonical 字段是 `body`、`outcome`、`confidence`、`evidence_event_ids`、`subject`、`status` 和 `metadata`。候选项里的 `subject.file_paths`、`subject.artifact_ids`、`subject.source_uris`、`evidence_event_ids` 必须是非空字符串数组。本地候选文件证据（包括 `file://` URI）必须留在 project root 内；外部 HTTP(S) URI 允许使用。候选项不能设置 `supersedes`，不能使用受控事件类型，也不能包含未知字段。AutoResearchClaw worker 应该自己写出 artifact，不能再派发嵌套 worker 或后台任务。

候选记忆的 canonical 形状如下：

```json
{
  "type": "finding",
  "summary": "Context pack preserved the negative result evidence chain.",
  "body": "Optional detail for reviewers.",
  "outcome": "worked",
  "confidence": 0.82,
  "evidence_event_ids": ["mem_evt_context_pack_created"],
  "subject": {
    "file_paths": ["results/context-pack-eval.json"],
    "source_uris": ["https://example.test/paper"],
    "artifact_ids": ["artifact-results"]
  },
  "status": "candidate",
  "metadata": { "source": "autoresearchclaw" }
}
```

Memory Core 只在 validation / ingest 边界接受三个历史候选别名：`candidate_type` 映射到 `type`，`evidence_ids` 映射到 `evidence_event_ids`，`evidence_paths` 映射到 `subject.file_paths` 或 `subject.source_uris`。规范化后的 memory event 会把这些 deprecated alias 原始值保存在权威 metadata 里，便于审计；worker 自己伪造的 deprecation metadata key 会被移除，同时系统会发出包含 project / run / candidate / alias 名称的结构化 deprecation telemetry。新的 AutoResearchClaw artifact 必须使用上面的 canonical 字段；未知 alias 仍然无效。

JSON artifact 是系统级权威输出。只要项目 root 内出现了合法 artifact，Memory Core 就可以先收割并 ingest；即使 worker 进程还没自然退出，也不应丢弃已经通过 contract 校验的 artifact。Memory Core 完成 artifact finalization 后，会请求 WorkerManager 做 external completion / soft-stop，避免 run 已经 finalized 但 worker 仍长期显示 `running`。

异步任务的状态回复会包含 `phase`、`progress`、`elapsedMs`、`retryAfterMs` 和 `nextAction`。符合 AutoResearchClaw 形态的请求会返回 phased progress，包括 project id、已提供的 run id、project root、domain、计划阶段，以及可直接执行的 Memory Core 状态查询命令。`metabot research runs` 是 system-of-record：run 应显示 `finalization_phase`、`worker_status_before`、`worker_status_after`、`worker_soft_stop_requested`、必要的错误信息和下一步动作。长时间 research run 还可以通过 Memory Core run status 查看更细的生命周期状态。

手动 AutoResearchClaw ingest 不只写 memory events，也会同步 `metabot research runs` 和 `metabot research artifacts` 使用的 run/artifact projection。开启 review 时，projection 可能显示 `partial`，表示候选记忆仍在等待 review。

## 你会在飞书里看到什么

飞书卡片和消息会展示：

- 当前是否已经生成 context pack。
- 是否已经派发 worker。
- worker 的运行状态、失败原因或完成摘要。
- 结构化输出是否通过校验。
- 新增了哪些候选记忆、项目记忆或待审批 promotion。

如果 worker 没有产出合法结构化结果，系统会把 run 标记为 failed，不会把不可信内容写进长期记忆。

## 查看进展

可以直接问：

```text
proj-alpha 最近的 research runs 有哪些？每个 run 的状态、worker、artifact 路径分别是什么？
```

```text
总结 proj-alpha 最新一次 AutoResearchClaw run：
列出 hypotheses、findings、negative results、decisions 和 open questions。
```

```text
查看 run-smoke-1 产生了哪些 artifacts，哪些已经进入 memory，哪些还在 candidate review。
```

## 审批和提升

自动科研系统不会让 worker 直接写入跨项目记忆。跨项目复用必须走 promotion。

常用审批说法：

```text
把这条 project memory 申请提升为 domain memory。
请先列出 memory id、证据、适用 domain 和风险，等我确认。
```

```text
批准刚才的 promotion request，提升到 metabot domain。
理由：已有两个独立 run 支持，且适用于后续所有 MetaBot research worker。
```

```text
拒绝这个 promotion。理由：证据只来自一次失败实验，还不能跨项目复用。
```

如果发现旧记忆不再适用：

```text
这条记忆已经过时。请用新结论 supersede 它，并保留旧证据链。
```

如果含有敏感信息：

```text
这条 memory 包含敏感路径，请 redact。保留审计记录，但不要再让它进入搜索或 context pack。
```

## 输出质量要求

一次合格的 research run 至少应该能回答：

- 这次尝试验证了什么假设。
- 做了哪些实验或分析。
- 哪些结论有证据，证据在哪里。
- 哪些方法失败了，为什么失败。
- 当前项目应遵守哪些新决策或约束。
- 下一次 research loop 应该从哪里继续。

如果这些内容缺失，可以在飞书里要求：

```text
这次 run 的输出不完整。请补齐 negative_results、decisions 和 open_questions，
并说明每条 finding 的 evidence。
```

## 常见问题

**Bot 说 root 不允许访问。**<br>
需要在部署环境里把项目路径加入 `METABOT_MEMORY_ALLOWED_ROOTS`。这是防止飞书消息让 Bot 任意读写机器路径的保护。

**Bot 说不能直接写 domain/global memory。**<br>
这是预期行为。先写 project/private，再申请 promotion，并由用户审批。

**worker 完成了但没有记忆。**<br>
通常是 AutoResearchClaw 输出没有通过 contract 校验，或 artifact 路径越界。让 `research-pm` 展示失败原因和 artifact 校验错误。

**什么时候用 MetaMemory，什么时候用 Research Memory Core？**<br>
人类读的报告、会议纪要、架构蓝图写 MetaMemory；未来 worker 需要自动检索、引用、压缩进 context pack 的科研事实写 Research Memory Core。

## 相关文档

- [Memory Core](memory-core.zh.md)
- [Agent 团队](agent-teams.zh.md)
- [MetaMemory](metamemory.zh.md)
