# `metabot` — Claude Code skill bundle

This directory ships the canonical Claude Code skill for the unified `metabot` CLI. It's the address-book + memory + skills front-end for the entire metabot-core stack.

## Install

```bash
# Per-project (default): writes to <cwd>/.claude/skills/metabot/SKILL.md
metabot skills install metabot

# Global (recommended for personal Claude Code installs):
metabot skills install metabot --to ~/.claude/skills/metabot
```

**Mind the install path landmine.** `metabot skills install <name>` (and its alias `mh install <name>`) defaults to `<cwd>/.claude/skills/<name>` — a per-project install. If you want every Claude Code session on your machine to see this skill, pass `--to ~/.claude/skills/metabot`. Without that flag, other sessions outside the install cwd will not see the skill and will wonder why `metabot agents …` shows up as an "unknown command" hint instead of a usable tool.

The legacy `metamemory` and `skill-hub` Claude Code skills keep working unchanged; this one is purely additive.

## What's inside

- `SKILL.md` — the user-facing skill manifest with frontmatter (`name`, `description`) and the full `metabot` CLI reference: `memory`, `skills`, `agents` (incl. `talk <peer>/<bot> <chatId> "<msg>"`), and the `t5t` placeholder.

## Source of truth

This skill is published from this directory inside `metabot-core`. To re-publish after editing:

```bash
metabot skills publish metabot --from packages/skills/metabot
```
