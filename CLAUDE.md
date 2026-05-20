# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repo. Behavior + working mode + config only; deeper reference material lives in `docs/internal/`.

## Project Overview

MetaBot — a bridge service that connects IM bots (Feishu/Lark) to the Claude Code Agent SDK. Users chat with Claude Code from Feishu (including mobile), with real-time streaming updates via interactive cards. Runs Claude in `bypassPermissions` mode (or `auto` mode when running as root) since there's no terminal for interactive approval.

This repo is a **monorepo**. The bridge runtime lives at the repo root (`src/`, `bin/`, `web/`, ...). The absorbed `metabot-core` half (ECS HTTP server, CLI, central SPA, shared HTTP clients, skill bundle) lives under `packages/`. The two halves communicate **only** over HTTP `/api/*` — never via in-process imports. See [docs/internal/architecture.md §Monorepo layout](docs/internal/architecture.md) for the boundary rules.

Deep reference (don't paste back into context unless needed):
- Architecture: [docs/internal/architecture.md](docs/internal/architecture.md)
- Feishu app setup: [docs/internal/feishu-setup.md](docs/internal/feishu-setup.md)
- HTTPS / Caddy: [docs/internal/https-setup.md](docs/internal/https-setup.md)
- Troubleshooting + prerequisites: [docs/internal/troubleshooting-claude.md](docs/internal/troubleshooting-claude.md)

## Working Mode: Orchestrate via the Resident Agent Team

When you (Claude) are the bot working on this repo from the owner's Feishu MetaBot chat, a resident agent team is already spun up. **Your default role is team-lead / orchestrator — you issue commands and route work; team members do the implementation. The main agent does not implement.**

Team **`metabot-oc_2e595-infra`** — 4 members, all `general-purpose`:

| Name | Domain |
|---|---|
| `lead-architect` | Strategy, roadmap, ADRs, prioritization, cross-cutting design |
| `backend-engineer` | Node/TS server code (`src/` for bridge, `packages/server/`, `packages/cli/`, `packages/cli-core/`, `packages/metamemory/`, `packages/skill-hub/`) — engines, executors, bridges, APIs, skills, sync |
| `frontend-engineer` | Web UI (`web/` for bridge, `packages/web-ui/` for central SPA), Feishu/Telegram/WeChat card builders, voice mode |
| `qa-reliability` | Tests, smoke validation, regression hunting, observability, CI health |

### Dispatch vs. do

**DO yourself**: `git status` / `git log`, reading a single file to answer a question, syncing `dev` after a teammate merge, writing memory files, one pre-approved PR comment, merging a green PR.

**DISPATCH**: any source-code edit in `src/` / `web/` / `packages/**`, running `npm test` / `npm run build` / `npm run lint` as your own work, opening a PR, designing a new feature (→ `lead-architect`), verifying a PR with regression risk (→ `qa-reliability`), broad codebase exploration that needs multiple rounds (→ `Explore` ad-hoc agent).

**CONFIRM with user first** for external-facing actions (3rd-party PR comments, force-push, deploy). If the user explicitly says "你自己来" / "你来写", DO.

### How to dispatch

1. Strategic or unclear scope → `SendMessage` to `lead-architect`. They scope, then delegate.
2. Clear implementation task → `SendMessage` directly to the engineer who owns that domain. Brief them with: what to do, files involved, definition of done, the Feature Completion Workflow steps.
3. Verification / test writing → `SendMessage` to `qa-reliability` after the engineer ships a PR.

### Definition of done — per role

**lead-architect** before going idle:
- Spec concrete enough that an engineer can execute without follow-up questions.
- Tradeoffs and rejected alternatives stated.
- Teammate dispatched, OR "design only" reported back to team-lead.

**backend-engineer** / **frontend-engineer** before going idle:
- Code change committed on a feature branch off `main` (PRs target `main`; `dev` is synced after merge).
- `npm run build && npm test && npm run lint` all green locally.
- README.md / README_EN.md / CLAUDE.md updated when user-facing behavior, API, CLI, or architecture changed.
- PR opened against `main`, CI watched; merged + `dev` synced once green.
- Report PR URL + merge SHA back to team-lead.

**qa-reliability** before going idle:
- Regression scenarios enumerated and exercised against the PR.
- New tests added when a gap was found; CI passes.
- Smoke validation against `metabot restart` where feasible.
- Report result (PASS / regressions + locations) back to team-lead.

### Operational notes

- **Silent-idle pattern**: teammates sometimes go idle without sending a completion message. Trust but verify — query the GitLab MR via API or check `git log` / file state directly. Re-ping with a tight finish-the-workflow instruction if they stopped partway.
- **Team-panel UX is broken** on SDK 0.2.140 — `TaskCreated` / `TaskCompleted` / `TeammateIdle` hooks don't fire, so teammates surface via the Feishu background-activity card. Functional, not visual. Known bug; don't debug.
- **Peek at teammate progress** via `~/.claude/projects/<projDir>/<sessionId>/subagents/agent-*.{jsonl,meta.json}`.
- **Team lifecycle**: the team is keyed to the persistent executor for this `chatId`. `/reset` evicts the executor and kills the team; recreate from the charter in `project_metabot_infra_team.md`.

### What the user expects

- **Concise dispatch + concise status relays.** No long internal narration.
- **Autonomous execution** — once a task is dispatched, drive it to merge + dev sync without intermediate approval gates, unless the action is risky/irreversible.
- **Don't ask "should I do X?" when you can just do X and report it.**

## Commands

```bash
npm run dev          # Bridge dev with tsx (hot reload)
npm run build        # tsc -b (root + workspaces) + build web frontend
npm run build:web    # Build bridge web frontend only (Vite → dist/web/)
npm start            # Run bridge compiled output (dist/index.js)
npm test             # Run bridge + workspace tests (vitest)
npm run lint         # ESLint check (root + workspaces, enforces HTTP-boundary rule)
npm run format       # Prettier format
```

Workspace-specific build/test/start (e.g. ECS server): `cd packages/server && npm run build && npm start`. Never `node packages/*/dist/...` from the bridge runtime — see boundary rules in [docs/internal/architecture.md](docs/internal/architecture.md).

## Configuration

Slim summary only — see [docs/internal/architecture.md](docs/internal/architecture.md) for deep details.

- **Single-bot mode** (default): `.env` with `FEISHU_APP_ID` + `FEISHU_APP_SECRET` (see `.env.example`).
- **Multi-bot mode**: `BOTS_CONFIG=./bots.json` runs multiple bots in one process (see `bots.example.json`). When set, the `FEISHU_APP_*` env vars are ignored.
- **PersistentClaudeExecutor** (opt-in): `METABOT_PERSISTENT_EXECUTOR=true` keeps one long-lived `query()` per `chatId` so subagents / Agent Teams / `/background` / `/goal` survive across turns. Per-bot override via `persistentExecutor` in `bots.json`. Observability at `GET /api/executors`.
- **metabot-core central service**: MetaMemory + Skill Hub + Agents + T5T live in this repo at `packages/server` (ECS deploy unit) and `packages/web-ui` (central SPA). The bridge talks to it over HTTP at `METABOT_CORE_URL` (default `https://metabot-core.xvirobotics.com`). Bearer token from `METABOT_CORE_TOKEN` env or `~/.metabot-core/token` — get one at `<METABOT_CORE_URL>/cli` (SSO + Generate). Claude reads/writes through the unified `metabot` skill (installed by `install.sh` + `metabot update`); the legacy `mm`/`mh` CLIs and the standalone `metamemory` / `skill-hub` skill bundles are gone (Phase 4 hard-consolidation).
- **`metabot` CLI is the single binary** (`bin/metabot`) with three command categories. (1) Reserved bridge process-control subcommands handled in-script: `update`/`up`, `start`, `stop`, `restart`/`rs`, `logs`/`log`, `status`/`st`, plus bare/`help`/`--help`/`-h` (combined help, no node spawned). (2) Bridge daemon API — `bots`/`bot`/`talk`/`schedule`/`peers`/`stats`/`metrics`/`voice`/`bot-skills`/`health` curl the local bridge at `localhost:9100`, reading `API_PORT`/`API_SECRET` from the bridge `.env`. (3) Everything else (`t5t`/`agents`/`memory`/`skills` …) delegates to the metabot-core feature CLI via `exec node`. Resolution order: `METABOT_CORE_CLI` (explicit override) → local `packages/cli/bin/metabot`. `METABOT_CORE_URL`/`METABOT_CORE_TOKEN` are fed from the bridge `.env` only when not already exported. If unresolved, prints an actionable error + exit 1 (no node stack trace). `bin/mb` is a thin deprecation wrapper that forwards to `metabot` (`mb skills` → `metabot bot-skills`).

## Branching Strategy

Always develop on `dev` (or feature branches off `dev`). Never work directly on `main`.

- `dev` — active development.
- `main` — stable; only receives PR merges.
- Start on `dev`: `git checkout dev`.
- After merging a PR to `main`, sync back: `git checkout dev && git merge main && git push`.

## Feature Completion Workflow

For every feature or bug fix, unless the user says otherwise:

1. **Build & Test** — `npm run build`, `npm test`, `npm run lint`. Fix failures before proceeding.
2. **Update docs** — README.md, README_EN.md, CLAUDE.md (and relevant `docs/**`) when user-facing behavior, API, CLI, or architecture changed.
3. **Commit** — descriptive commit on the current branch.
4. **Push & MR** — push to internal GitLab `origin`; open MR against `main` via the GitLab REST API using `~/.gitlab-token` (PAT) — `POST /api/v4/projects/xvirobotics%2Fmetabot/merge_requests`.
5. **CI** — poll `GET /api/v4/projects/.../pipelines/<id>/jobs` until all jobs are `success`.
6. **Merge** — `PUT /api/v4/projects/.../merge_requests/<iid>/merge?squash=true&should_remove_source_branch=true`.
7. **Sync dev** — `git checkout dev && git merge main && git push`.

## Repo / Remotes

- Primary upstream: **internal GitLab** at `ssh://git@gitlab.xvirobotics.com:2222/xvirobotics/metabot.git` (set as `origin`).
- GitHub `xvirobotics/metabot` remains as a **read-only mirror** named `github` — don't push there as part of normal workflow.
- GitLab API token: `~/.gitlab-token` (PAT). SSH push uses `~/.ssh/id_ed25519` (mapped to user `floodsung`).

## Metamemory Hygiene

Orchestrator memory writes are allowed — they're hygiene, not work. All files live under `~/.claude/projects/-vepfs-users-floodsung-metabot/memory/` and are indexed by `MEMORY.md`.

**Folder convention — when to write each type:**

- `user_*` — who the user is, role, knowledge, durable preferences.
- `feedback_*` — guidance the user gave (correction OR confirmation). Body must include **Why:** and **How to apply:** lines.
- `project_*` — current initiatives, deadlines, stakeholders. Decay fast — keep **Why:** + **How to apply:**.
- `decision_*` — ADR-like records of why a path was chosen. **Drop one after every non-trivial PR merge**.
- `bug_*` — non-obvious bugs with workarounds.
- `arch_*` — load-bearing architecture facts not derivable from current code.
- `ref_*` — pointers to external systems (Linear, Grafana, file paths, session jsonl locations).

**After every meaningful merge, run the checklist:** non-obvious bug → `bug_*`; preserved decision → `decision_*`; user redirect → `feedback_*`; load-bearing arch fact → `arch_*`; then update `MEMORY.md` with a one-line pointer.

**Deprecating stale memory**: delete the file AND remove its line from `MEMORY.md`. Don't tombstone. If a memory contradicts current code, trust the code and remove the memory.

## Skill-Hub Publish Triggers

Publish a skill to skill-hub when:
- You wrote a 3+ step procedure another bot will need to follow.
- You discovered a non-obvious workaround (e.g. SDK quirk, IM platform edge case) future agents would otherwise relearn.
- The user explicitly says "save this as a skill".

**Don't** publish single-line wrappers, anything bot-specific (hardcoded `chatId`, app secrets, hostnames), or one-off scripts.

Command: `metabot bot-skills publish <botName> <skillName>` (backed by `POST /api/skills/:name/publish-from-bot`).
