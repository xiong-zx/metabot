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

- `METABOT_CORE_URL` — default `https://metabot-core.xvirobotics.com` (dedicated front-door domain since the P4-MR6 pivot)
- `METABOT_CORE_TOKEN` — bearer token (falls back to first line of `~/.metabot-core/token`)
