# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Changed
- **CLI merge — `mb` folded into `metabot`** — `metabot` is now the single CLI binary. It absorbed the bridge daemon API commands formerly under `mb` (`bots`, `bot`, `talk`, `schedule`, `peers`, `stats`, `metrics`, `voice`, `health`), which curl the local bridge at `localhost:9100`. The per-bot Skill Hub moved to a new distinct command word — `metabot bot-skills` (was `mb skills`) — to avoid colliding with the central `metabot skills` delegation. `bin/mb` is now a thin deprecation wrapper that forwards to `metabot` (`mb skills` → `metabot bot-skills`); existing `mb` scripts keep working with a stderr notice. The stale `mb()` bash-alias function is no longer written to `~/.bash_aliases` by `install.sh`.
- **Monorepo merge** — absorbed `xvirobotics/metabot-core` into this repo as an npm-workspaces monorepo under `packages/`. The central HTTP server, feature CLI, central SPA, and shared clients now live alongside the bridge runtime. Bot-host installs no longer clone a sibling repo; `metabot update` does a single pull + build. HTTP `/api/*` remains the only boundary between bridge and server halves, enforced by `package.json` exports, ESLint `no-restricted-imports`, and start-script contracts. ECS server source path moves from `~/metabot-workspace/metabot-core` to `~/metabot/packages/server`. Per-file history preserved via subtree-merge (MR !8, squash `3766982f`).

### Added
- `install.sh`: `--dir <path>` / `-d <path>` flag to customize the install directory (priority: `--dir` > `METABOT_HOME` env > interactive prompt > `~/metabot`). Non-default paths are persisted to `~/.bashrc` / `~/.zshrc` so the `mb`/`mm`/`metabot` CLIs find the install in new shells.
- `install.ps1`: matching `-Dir <path>` parameter on Windows; non-default paths persisted via user-level `METABOT_HOME` environment variable.
- CONTRIBUTING.md with development setup guide
- GitHub Actions CI workflow (Node.js 20/22 build + type check)
- Issue templates for bug reports and feature requests
- README badges (CI, license, stars)

### Fixed
- Timeout error message now correctly shows "1 hour limit" instead of "10 min limit"
- Memory client API response format handling (unwrapArray/unwrapSingle)

## [1.0.0] - 2025-02-20

### Added
- Feishu/Lark to Claude Code bridge via Agent SDK
- Real-time streaming card updates
- Multi-bot support (multiple Feishu apps in one process)
- Multi-user parallel sessions (per-chat isolation)
- Multi-turn conversations with session persistence
- Image support (send to Claude, receive generated images)
- File upload/download support
- MCP server integration (loads from Claude Code settings)
- Interactive Q&A (Claude can ask questions, user answers in chat)
- Status cards with color-coded states, tool call tracking, cost/duration
- Memory server integration (MetaMemory)
- Bot commands: `/help`, `/reset`, `/stop`, `/status`, `/memory`
- Authorization via user IDs and chat IDs
- PM2 deployment with auto-restart
