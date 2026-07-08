# Memory Core

Memory Core is MetaBot's execution-grade memory system. It is designed for agents and workers, not as a generic note-taking layer. Its job is to turn research and engineering experience into searchable, auditable, token-efficient system assets.

## Memory Core vs MetaMemory

| System               | Audience          | Stores                                                                    | Execution-critical        |
| -------------------- | ----------------- | ------------------------------------------------------------------------- | ------------------------- |
| Research Memory Core | agents / workers  | facts, decisions, negative results, constraints, open questions, evidence | Yes                       |
| MetaMemory           | humans and agents | Markdown summaries, reports, architecture notes, meeting notes            | No                        |
| Local project files  | current project   | `AGENTS.md`, `CLAUDE.md`, stable rules and paths                          | Yes, but short and stable |

Memory Core is machine execution memory. MetaMemory is human knowledge documentation.

## Core Objects

| Object       | Meaning                                                                                       |
| ------------ | --------------------------------------------------------------------------------------------- |
| Memory Event | append-only original event with actor, scope, evidence, and timestamp                         |
| Memory Unit  | compressed, retrievable memory derived by the curator                                         |
| Context Pack | token-budgeted task context generated for coding, research, review, planning, ops, or reports |

Events are not physically rewritten. Outdated or sensitive memories are handled through supersede / redact tombstones while preserving audit history.

## Scope and State

Scopes:

| Scope   | Use                                    |
| ------- | -------------------------------------- |
| private | local attempt or actor-specific memory |
| project | reusable inside one project            |
| domain  | reusable across projects in one domain |
| global  | high-confidence system-wide rule       |

Direct writes are limited to private/project memory. Domain/global memory requires promotion approval.

States include candidate, active, pending_review, rejected, superseded, and redacted.

## Feishu/Lark Usage

Users do not need to call MCP tools directly. Ask `research-pm` / `admin` in natural language.

Record memory:

```text
Record this as project memory for proj-alpha:
AutoResearchClaw workers may produce structured JSON, but must not directly write long-term memory.
Evidence: run-smoke-1 passed output validation today.
```

Terminology note: users may say "fact", but the append-only event type for a verified fact-like observation is `finding`. The CLI and MCP accept `fact` as a shorthand and map it to `finding`; memory units may still be presented as facts in context packs.

Search memory:

```text
Search proj-alpha memory for negative results related to token budget.
Return only active memory and include memory id plus evidence.
```

Build a context pack:

```text
Build a context pack for continuing AutoResearchClaw ingest validation.
projectId=proj-alpha, domain=metabot, token budget 3000.
Explain which memories were included and which were excluded by scope/status.
```

Promotion:

```text
This project memory seems reusable across the metabot domain.
Create a promotion request, show evidence and risk, and wait for my approval.
```

Supersede or redact:

```text
Supersede the old memory with the new conclusion, and keep the evidence chain.
```

```text
Redact this memory because it contains a sensitive local path.
```

## Context Pack Rules

The default context pack prioritizes current project decisions, constraints, negative results, relevant findings, domain memory, and a small amount of global memory.

It excludes rejected, redacted, superseded, out-of-scope, and candidate memory unless explicitly requested.

## Related

- [Auto Research System](auto-research.md)
- [MetaMemory](metamemory.md)
- [Agent Teams](agent-teams.md)
