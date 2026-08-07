# Production Deployment

The signed GitHub Release installer is the supported Personal Edition
deployment path. It installs four local services. The execution daemons are
PM2 siblings of Bridge, not Bridge children:

| Service | Default port | Purpose |
|---|---:|---|
| Core Console | `9200` | Web UI, Chat, Agents, Memory, Skills, T5T, Teams, CLI APIs |
| Bridge | `9100` | IM channels, engine execution, scheduling, voice, peer routing |
| Worker Runner | `9311` | Durable one-shot Codex, Claude, and Kimi MCP work |
| ARC | `9312` | Durable AutoResearchClaw lifecycle over Worker Runner |

MetaMemory is part of Core. There is no standalone service on port `8100`.

## Install and verify

```bash
curl -fsSL https://github.com/xvirobotics/metabot/releases/latest/download/install.sh | bash

metabot status
metabot doctor
curl -fsS http://localhost:9200/health
```

The installer verifies `SHA256SUMS`, validates the Personal Edition manifest,
builds both MCP packages plus their adapter, and saves the owned PM2
applications only after Bridge and both authenticated daemon probes pass.
Enable boot persistence after the services are healthy:

```bash
pm2 save
pm2 startup
```

Run the command printed by `pm2 startup`, then run `pm2 save` again.

## No inbound port is required for chat channels

- Feishu/Lark uses a persistent outbound WebSocket.
- Telegram uses outbound long polling.
- Local Web access works on loopback.

Only publish Core when remote browser access is intentional. Keep Bridge on
loopback or a private network unless a separate authenticated API endpoint is
required.

## HTTPS reverse proxy

Mobile microphone access and remote browser use require a secure context. A
minimal Caddy configuration proxies the single Core Console:

```caddy
metabot.example.com {
    reverse_proxy 127.0.0.1:9200
}
```

Then configure remote CLI clients:

```bash
export METABOT_CORE_URL=https://metabot.example.com
export METABOT_CORE_TOKEN="<personal-token>"
metabot memory health
```

Use a private network such as Tailscale or WireGuard when public access is not
needed. Never publish the raw token in a URL, shell history, or shared config.

## Bridge remote access

Most users do not need this. Commands such as `metabot bots`, `schedule`,
`teams`, `peers`, and `voice` use the Bridge API. If remote Bridge access is
required:

1. set a strong `API_SECRET`;
2. proxy `127.0.0.1:9100` through a separate authenticated HTTPS hostname or a
   private network;
3. set `METABOT_URL` on the client.

Do not reuse the Core token as the Bridge secret.

## Update and rollback

```bash
metabot update                                  # latest verified release
metabot update --package --version 1.3.0        # known immutable release
metabot doctor
```

`metabot start` and `metabot stop` operate on Bridge and both execution
daemons. Ordinary `metabot restart` is intentionally Bridge-only, so detached
work survives it. A daemon restart is explicit and guarded:

```bash
metabot restart --request-id <stable-id> --wait --json
metabot restart --daemon worker
metabot restart --daemon arc
metabot restart --daemon worker --force
```

The guarded form refuses while durable work is active. `--force` is an
operator acknowledgement: ambiguous in-flight work can become
`recovery_required` and is never blindly relaunched. Updates perform the same
busy check, drain idle daemon connections, then restart both daemons so old
code never continues against a migrated database.

The protected Bridge restart never deletes its PM2 registration. It claims
the request ID in SQLite, atomically writes `last-restart.json`, and restarts
only Bridge in the same cwd/script. A duplicate request ID returns the durable
record without restarting again. After startup, the new Bridge verifies its
HTTP endpoint, both daemon wire endpoints, and PM2 identity; it saves the PM2
list only after all checks pass. Normal user/PM chats with `--resume` receive
one durable continuation in their existing session. Agent Team and
Worker/ARC internal chats remain owned by their purpose-built durable recovery.

Before that protected transition touches PM2, the authenticated local Bridge
quiesces every registered bot, atomically snapshots every affected active
chat, and sends a preparation notice through each bot identity. After startup
health and `pm2 save` succeed, it durably queues one continuation per affected
user chat and sends per-bot completion notices. Use the CLI rather than direct
`pm2 restart`; direct PM2 commands bypass this contract. The first upgrade from
an older Bridge uses one explicit compatibility handoff because the running
old process does not yet expose the prepare endpoint.

Package overlays preserve `.env`, `bots.json`, `data/`, `logs/`, and user/Core
state under `~/.metabot/` and `~/.metabot-core/`. If a new release fails your
smoke checks, reinstall the previously known version explicitly instead of
editing installed package files.

Multi-bot handoff state is additive (`controlled-restart.json`) and does not
change `sessions.db`. A rollback may reinstall the previous release without a
database restore. Remove a stale handoff JSON only after confirming no restart
is in progress; older releases ignore it.

When rolling back to a release from before the execution daemons existed,
remove their saved PM2 entries as well as installing the old package:

```bash
pm2 delete metabot-worker-runnerd metabot-arcd
pm2 save
```

The Ed25519 trust keys and SQLite state under `~/.metabot/` may remain; they are
inert when the old runtime has no matching apps. For a source runtime switch,
run `metabot deploy-runtime --runtime /absolute/checkout` from SSH or another
controller outside the MetaBot process tree. It refuses active work unless
`--force`. The command prevalidates target and rollback configurations, then
changes Worker Runner, ARC, and Bridge in place without a `pm2 delete` gap.
Failure rolls back every app PM2 already accepted. The old controller does not
save PM2 state; the new Bridge saves it only after full startup health. Use a
stable `--request-id` for retryable automation and `--wait --json` for a
durable terminal result.

Personal Edition Core remains a separate PM2 ecosystem. A runtime cutover adds
it between ARC and Bridge only when the current Core PM2 cwd and script exactly
match the current Bridge checkout; the target must also contain the separate
Core ecosystem and built server. A remote or separately managed Core is never
restarted or switched. `uninstall.sh` likewise removes Core only when that
ownership check passes, so uninstalling Bridge cannot delete an external Core.

## Source deployments

Source checkouts use an explicit path:

```bash
git pull --ff-only
npm ci --include=dev
npm test
npm run build
metabot update --git
```

Keep package-managed and source-managed installations separate. For the Web
request path, see [Core Console architecture](../features/web-ui.md#architecture).
