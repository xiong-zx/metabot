# Onboarding — metabot-core in 30 seconds

The unified front door for the team is **`https://metabot-core.xvirobotics.com`**.
Same URL for the browser portal AND for the `metabot` CLI. Login is 飞连 OIDC
(everyone in `@xvirobotics.com` lands here automatically).

> **Heads-up on the URL:** this is a dedicated domain, NOT the shared
> multi-tenant `metabot.xvirobotics.com` (which hosts a bunch of unrelated
> sub-handles owned by other teams). Mind the dash — `metabot-core`, not
> `metabot.core`.

## Setting up the `metabot` CLI in 30 seconds

1. **Open** `https://metabot-core.xvirobotics.com` in a browser (you must be on
   the 飞连 VPN, or on a host inside the corp network).
2. **Log in** via 飞连 (single-click if you're already signed in to the IDP).
3. **Navigate** to the **CLI Access** page from the portal nav.
4. **Click** the **Generate** button. The page renders a copy-ready `.env`
   block:
   ```
   METABOT_CORE_URL=https://metabot-core.xvirobotics.com
   METABOT_CORE_TOKEN=mt_<32-hex>
   ```
5. **Paste** it into one of these:
   - `~/.metabot-core/.env` (auto-sourced by every shell session if you keep
     a one-liner in your `.bashrc` / `.zshrc`), OR
   - your shell directly: `export METABOT_CORE_URL=… METABOT_CORE_TOKEN=…`
6. **Verify**: `metabot agents whoami` — should echo your `@xvirobotics.com`
   identity.

That's it. Same token works for `metabot memory …`, `metabot skills …`,
`metabot agents …`, `metabot t5t …`.

### Token rotation

Re-clicking **Generate** issues a fresh token AND revokes your previous
self-service token in the same operation. This is intentional — it's how
you rotate a leaked or shared-by-accident credential. Old admin tokens
(issued by the central-admin CLI) are NOT touched by the web flow.

If you re-generate, also re-paste the new value into your `.env` /
shell — the previous one will start returning `401 unauthorized` within
seconds.

## Migration from the old `mb` / `mm` / `mh` CLIs

P4-MR4 (2026-05-18) removed the legacy binaries. Every CLI surface is
now reached via `metabot <subcommand>`:

| Old (removed) | New (canonical) |
|---|---|
| `mm <cmd>` | `metabot memory <cmd>` |
| `mh <cmd>` | `metabot skills <cmd>` |
| `mb talk <bot> <chatId> "<msg>"` | `metabot agents talk <peer>[/<bot>] <chatId> "<msg>"` |
| `mb skills publish <bot> <skill>` | `metabot skills publish <skill> --from <dir>` |
| (n/a) | `metabot agents list / register / heartbeat / visible / hide` |
| (n/a) | `metabot t5t board / push / goal / feedback / …` |

If `command -v mm` (or `mh`, `mb`) still resolves on your machine, you have a
stale install from before the cutover. Reinstall via the `metabot` skill or
your dotfiles bootstrap. There are intentionally no compatibility shims —
muscle-memory uses of the old names will (cleanly) fail with `command not
found` until you switch.

## Migration from the old Python `t5t` CLI

The standalone Python `t5t` binary (hardcoded against `t5t.xvirobotics.com`)
is retired. All daily-status workflows move to `metabot t5t`:

| Old | New |
|---|---|
| `t5t push <slug> <date> "<item>"` | `metabot t5t push <slug> <date> "<item>"` |
| `t5t board` | `metabot t5t board` |
| `t5t goal <slug> "<text>"` | `metabot t5t goal <slug> "<text>"` |
| `t5t feedback <entry> "<comment>"` | `metabot t5t feedback <entryDocId> "<comment>"` |
| `~/.t5t/credentials` | discarded — use the self-service token above |

The old standalone `t5t.xvirobotics.com` host is gone — no redirect, no
soft-landing. Update bookmarks to `https://metabot-core.xvirobotics.com/t5t`.
The old Python CLI itself is dead with the cutover.

## URL story — what's where (P4-MR6, 2026-05-19 domain pivot)

| URL | Status |
|---|---|
| `https://metabot-core.xvirobotics.com` | **The canonical front door** (browser + CLI default). Single host for SPA, API, admin, t5t board, memory, skills, agents. |
| `https://metabot.xvirobotics.com` | **Untouched.** Shared multi-tenant Caddy host owned by several teams (`/slam-video`, `/droidw-viz`, `/nav-viz`, `/pipeline`, `/seedance`, `/bp`, `/dreamfactory`, `/core`, …). Don't expect the metabot-core SPA at the bare root here. |
| `https://metabot.xvirobotics.com/core` | **Still works**, indefinitely. Legacy sub-handle for CLIs configured against this URL before the pivot. No compat alias — just the original Caddy block kept as-is. |

## Things that are GONE (don't look for them)

- `mb` / `mm` / `mh` binaries — removed by P4-MR4.
- standalone `metamemory` / `skill-hub` Claude Code skills — folded into the
  single `metabot` skill bundle.

## What lives where now

| Surface | URL / path |
|---|---|
| Portal (read-only browser console) | `https://metabot-core.xvirobotics.com` |
| CLI Access (self-service token) | `https://metabot-core.xvirobotics.com/cli` |
| t5t board | `https://metabot-core.xvirobotics.com/t5t` |
| metamemory browse | `https://metabot-core.xvirobotics.com/memory/...` |
| skill hub | `https://metabot-core.xvirobotics.com/skills` |
| agents read-only list | `https://metabot-core.xvirobotics.com/agents` |
| CLI base URL | `https://metabot-core.xvirobotics.com` (no `/core`) |
| Skill bundle (single) | `metabot skills install metabot` |

## Trouble?

- `metabot agents whoami` → `no token configured`: check
  `cat ~/.metabot-core/.env` exists and `echo $METABOT_CORE_TOKEN` is set in
  your current shell.
- `metabot agents whoami` → `401 unauthorized`: your token was rotated by a
  more recent **Generate** click. Open the portal again and regenerate.
- Portal → 飞连 login loop: confirm you're on the 飞连 VPN. The host has
  split-DNS — only resolves from inside the corp network.
- Old `mb`/`mm`/`mh` muscle memory: they're gone on purpose. Update your
  scripts to `metabot <subcommand>` form. If a teammate's tool still calls
  them, ping them with the migration table above.
