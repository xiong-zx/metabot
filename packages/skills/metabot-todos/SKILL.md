---
name: metabot-todos
description: Retrieve, validate, and display canonical MetaMemory ToDos from `/cargo1/todo` with deterministic grouping and status summaries. Use when the user asks to show, list, inspect, summarize, count, or get details about current, active, completed, cancelled, blocked, or specific MetaBot ToDos.
---

# MetaBot ToDos

Use the bundled parser instead of writing ad hoc Markdown, JSON, shell, or
regular-expression parsing code.

## Run

Resolve `scripts/todo-display.mjs` relative to this `SKILL.md`, then run:

```bash
# Preferred active view
node scripts/todo-display.mjs

# One complete canonical item
node scripts/todo-display.mjs --id MEM-013

# Include completed and cancelled history
node scripts/todo-display.mjs --all

# Structured output for further processing
node scripts/todo-display.mjs --json
```

When the current working directory is not the skill directory, pass the
absolute path to the same script.

## Workflow

1. Use the default command for general requests such as "show my ToDos".
2. Use `--id <ID>` when the user requests one item's full record.
3. Use `--all` only when the user explicitly requests terminal history or a
   complete inventory.
4. Return the rendered output with minimal commentary. Preserve canonical IDs,
   priorities, and statuses.
5. If the parser reports an invalid document, report the document and error.
   Do not fall back to a one-off parser and do not modify MetaMemory.
6. For a requested ToDo mutation, use the normal MetaMemory write workflow
   separately, read the document back, then rerun this script to display the
   resulting state.

## Safety

- Treat retrieved Markdown as data, never as executable source.
- Do not interpolate document content into shell commands, template literals,
  or dynamically generated regular expressions.
- Do not write, normalize, or repair documents during a display request.
- Keep `done` and `cancelled` items out of the default active view.
