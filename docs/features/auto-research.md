# Auto Research System

The Auto Research system turns a research project into a supervised, resumable research loop. Users describe the goal in Feishu/Lark; MetaBot coordinates `research-pm`, internal agents, WorkerManager, AutoResearchClaw, and Memory Core.

## When to Use It

Use it for literature analysis, hypothesis generation, experiment planning, code execution, result analysis, negative-result tracking, and iterative refine / pivot loops.

Do not use it as a generic chat archive. Human-readable reports belong in MetaMemory; execution-critical facts and decisions belong in Memory Core.

## Feishu/Lark Usage

Message `research-pm`. If the deployment does not expose a dedicated `research-pm`, message an `admin` / `manager` bot with worker access and explicitly ask it to use AutoResearchClaw and Research Memory.

Include:

| Field         | Example                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------- |
| project root  | `/root/workspaces/proj-alpha`                                                             |
| projectId     | `proj-alpha`                                                                              |
| domain        | `metabot`                                                                                 |
| goal          | `Verify whether context packs reduce repeated prompt history`                             |
| inputs        | paper URLs, dataset paths, logs, code paths                                               |
| outputs       | hypotheses, experiments, findings, negative results, decisions, artifacts, open questions |
| memory policy | `stage memory for review first`                                                           |

Example:

```text
Start an AutoResearchClaw research loop in /root/workspaces/proj-alpha.
projectId=proj-alpha, domain=metabot.
Goal: verify whether context packs reduce repeated prompt history compared with full history injection.
Generate a context pack before dispatching the worker.
The worker output must include hypotheses, experiments, findings, negative_results, decisions, artifacts, and open_questions.
Stage memory for review first; do not promote to domain/global directly.
```

## What Happens

1. `research-pm` reads local project rules and existing Research Memory.
2. Memory Core builds a token-budgeted context pack.
3. MetaBot dispatches an AutoResearchClaw worker through WorkerManager.
4. The worker performs the research loop and writes a structured JSON artifact.
5. The system validates the contract, artifact paths, and scope.
6. The curator converts valid output into memory events and memory units.
7. Review-required output stays as candidate memory until approved.
8. Human-readable summaries go to MetaMemory; execution facts stay in Memory Core.

Before a long AutoResearchClaw run starts, the bot should send a preflight summary in Feishu/Lark. That summary should include the project id/root/domain, the context-pack stage, the worker dispatch stage, the required output contract, the ingest/review stage, completion criteria, and how to check status.

The required output contract is `autoresearchclaw.output.v2` with these top-level fields: `contract_version`, `project_id`, `run_id`, `status`, `summary`, `hypotheses`, `experiments`, `findings`, `negative_results`, `decisions`, `artifacts`, `open_questions`, `memory_event_candidates`, `recommended_followups`, and `tool_trace`.

Every nested evidence item must also satisfy the schema, not just the top-level keys: hypotheses, findings, negative results, decisions, open questions, metrics, and pivots need a non-empty `summary`; artifacts need `id`, `uri`, and `summary`; tool trace entries need `tool` and `summary`. AutoResearchClaw workers should write the artifact themselves and must not dispatch nested workers or background tasks.

The JSON artifact is the authoritative system output. Once a valid artifact appears under the project root, Memory Core may collect and ingest it even if the worker process has not exited yet; a later worker timeout should be treated as execution telemetry, not as a reason to drop an already valid artifact.

For async tasks, status replies include `phase`, `progress`, `elapsedMs`, `retryAfterMs`, and `nextAction`. Long research runs may also expose richer lifecycle details through Memory Core run status.

## Review and Promotion

Workers cannot directly create domain/global memory. Ask for promotion only after evidence is available:

```text
Request promotion of this project memory to metabot domain memory.
Show the memory id, evidence, target scope, and risk first. Wait for my approval.
```

Approve:

```text
Approve this promotion request to metabot domain.
Reason: two independent runs support it and it applies to future research workers.
```

## Troubleshooting

If the bot says the root is not allowed, add the project path to `METABOT_MEMORY_ALLOWED_ROOTS` before starting the bridge.

If a run finishes but no memory appears, ask `research-pm` for the contract validation error or artifact path error.

## Related

- [Memory Core](memory-core.md)
- [Agent Teams](agent-teams.md)
- [MetaMemory](metamemory.md)
