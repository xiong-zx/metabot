# @xvirobotics/cli

`metabot` — unified CLI that dispatches to the metabot-core subcommand
families. Thin wrapper over the existing per-family CLIs; no logic of
its own beyond subcommand routing.

## Subcommands

| Subcommand           | Backed by                  | Notes                          |
|----------------------|----------------------------|--------------------------------|
| `metabot memory`     | `@xvirobotics/metamemory`  | alias of `mm`                  |
| `metabot skills`     | `@xvirobotics/skill-hub`   | alias of `mh`                  |
| `metabot agents`     | (pending MR5)              | prints placeholder string      |
| `metabot t5t`        | (pending Phase 3 — trunks) | prints placeholder string      |
| `metabot help`       |                            | also `--help`, `-h`, no args   |

The existing `mm` and `mh` binaries keep working unchanged — this is
additive.

## Install

```
npm install -g @xvirobotics/cli
metabot help
```

## Env

- `METABOT_CORE_URL` — default `http://localhost:9200` (locally self-hosted metabot-core); set your own remote host if you run it elsewhere
- `METABOT_CORE_TOKEN` — bearer token (falls back to first line of `~/.metabot-core/token`)

## Worktree deployments

The bridge may run from a Git worktree that has source files but no
`packages/cli/dist/index.js`. The host `bin/metabot` launcher checks both the
feature CLI entry and its build artifact before delegation. If the active
worktree is unbuilt, it can use a ready CLI from the checkout that owns
`METABOT_DEFAULT_ENV_FILE`, then from `~/metabot`, without changing the selected
MetaMemory backend. Explicit `METABOT_CORE_URL` / `METABOT_CORE_TOKEN` values
still win; otherwise the shared default env is loaded before the worktree env.

Use `metabot doctor --json` before deployment to inspect `core_cli_artifact`,
the selected CLI entry, build readiness, and the configured/resolved env roots.
An explicit but unbuilt `METABOT_CORE_CLI` fails closed instead of silently
falling back. Build a worktree CLI with:

```bash
npm ci
npm run build -w @xvirobotics/cli
```
