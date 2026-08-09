# MetaBot Personal Edition Workspace

MetaBot connects chat-based agents with self-hosted Memory, Skills, Agent Bus,
Agent Teams, T5T, scheduling, and runtime operations. Use `metabot` as the
single CLI for these surfaces; legacy `mm`, `mh`, and `mb` workflows are
retired.

## Core CLI

```bash
metabot memory search "query"
metabot memory get <id|path>
metabot skills list
metabot agents list
metabot agents talk <agent> "message"
metabot inbox poll --loop
metabot teams status <team> --summary
metabot t5t push <project> <date> "entry"
```

Use the `metabot` Skill for command details and the `metabot-team` Skill for
durable Team state. Personal Core and its web console default to
`http://127.0.0.1:9200`; users may configure another Core with
`METABOT_CORE_URL`.

`AGENTS.md` is the canonical project instruction file. Existing workspace
`AGENTS.md` and `CLAUDE.md` files are user-owned and MetaBot install/update must
not replace them.

## Working Principles

- Start from the user's goal and inspect the actual workspace or runtime before
  acting.
- Carry authorized work through implementation and verification appropriate to
  its risk. Do not stop at a plan unless the user asked only for a plan.
- Keep changes focused and preserve unrelated files, local modifications, user
  data, configuration, and user-selected integrations.
- Choose the execution approach that best fits the task. Add coordination or
  extra process only when it materially helps the outcome.
- Use the injected Current MetaBot Context and Team Context as the current
  chat, schedule, roster, and routing source. Query `metabot teams` when more
  durable state is needed.
- Ask the user only when a missing decision, authority, credential, or unsafe
  action genuinely blocks progress.
- Never expose secrets or authorization tokens. Avoid destructive actions
  unless they are explicitly authorized and necessary.
- Before runtime or deployment work, verify the real target, current state, and
  rollback path. Do not assume host-specific paths, process names, or ports.
- Search before creating shared resources, and keep user-facing updates concise
  and evidence-backed.

## Upstream-First Development Policy

These rules are mandatory for every Agent that changes MetaBot code.

1. Treat `upstream/main` from `https://github.com/xvirobotics/metabot.git` as
   the code authority. Keep `origin/main` as a tested superset of the latest
   accepted `upstream/main`, and keep `origin/dev` fast-forwarded to
   `origin/main` rather than maintaining a second long-lived line.
2. Before material code work, inspect the real worktree and run the equivalent
   of `git status --short --branch`, refresh both remotes, and compare
   `upstream/main...origin/main`. Do not start a feature from a stale
   downstream baseline. Preserve unrelated dirty work in place and use a
   separate worktree when necessary.
3. Integrate new upstream work into downstream `main` with a real merge so
   upstream ancestry remains auditable. Do not rebase, squash, or force-push a
   shared `main`. When upstream accepts an earlier downstream fix, drop any
   patch-equivalent duplicate and retain only the still-required adaptation.
4. Classify every change before implementation:
   - **Upstreamable:** generic, public behavior starts from `upstream/main`,
     has focused tests/docs, contains no private/downstream dependency, and is
     proposed upstream independently.
   - **Downstream-only:** starts only after the upstream merge, lives in a
     declared extension/package/feature root, and touches upstream-owned core
     files only through the thinnest practical hook.
   - **Mixed:** split into an upstreamable core change and a separate
     downstream adapter. Never combine both into one omnibus commit.
5. Keep one important behavior per branch/commit. Use author and committer
   `xzXiao <xiongzhixiao88@gmail.com>`. Update
   `config/downstream-features.json` and boundary tests for every retained
   downstream feature, including its owned roots, forbidden imports, reason,
   and validation surface.
6. Use Node 22 and run risk-proportionate focused tests, full build/typecheck,
   lint, downstream-boundary checks, and `git diff --check` before integration.
   Never commit credentials, local auth, PM2 state, generated runtime data,
   `node_modules`, or an untracked `node_modules` symlink.
7. Code integration and runtime deployment are separate decisions. After code
   and tests, report the diff, test evidence, database migration steps, and
   rollback plan. Require explicit user authorization before deployment,
   runtime switching, restart, or replacing a live database.
8. Record durable architectural decisions and the final upstream/downstream
   classification in shared Meta Memory. The canonical durable rule is
   `/cargo1/rules/metabot-upstream-first-development`.

## Durable State

- T5T records project progress, evidence, blockers, and next actions.
- Meta Memory records decisions, reusable findings, and final state.
- Skills document reusable CLI or integration behavior; project execution
  policy stays in project instructions rather than packaged Skills.
- Agent Teams provide durable Agents, Messages, Tasks, and Runs across engine
  sessions.

## Public Boundary

- Keep Personal Edition self-hostable and free of private identity providers,
  employee directories, internal domains, private endpoints, and embedded
  credentials.
- Preserve public Feishu/Lark, Telegram, WeChat, and other user-configured
  integrations.
- Treat `lark-cli` and its Skills as user-managed. Mirror selected existing
  Lark Skills without overwriting locally modified copies.
