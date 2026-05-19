# metabot-core Roadmap

Status: revised 2026-05-18 after Flood's architecture correction.

> **Topology update (P4-MR6, 2026-05-19)**: the deployed front door is now
> the dedicated `https://metabot-core.xvirobotics.com` (CLI + browser both
> default here). The shared multi-tenant `metabot.xvirobotics.com` host is
> NOT used as the bare-root front door — only its legacy `/core` sub-handle
> is preserved so old CLI configs keep working. The standalone
> `metabot-core-ui.xvirobotics.com` and `t5t.xvirobotics.com` predecessor
> hosts were hard-cut at cutover (DNS + cert + Caddy block all removed —
> no soft redirect). **[DROPPED]** the originally-planned Phase B soft
> retirement via 301 redirect: Flood chose hard-cut ("我并不需要 redirect，
> 我就想在 metabot-core.xvirobotics.com 里直接用。其他都可以下线"). References
> below to `/core/*` and to `metabot-core-ui.xvirobotics.com` are preserved
> as the originally-planned topology; the deployed shape is documented in
> `packages/server/deploy/caddy/snippet.caddyfile` and
> `docs/internal/web-ui-arch.md`.

## What this repo is

A standalone, **centrally deployed** home for **metamemory** and **skill-hub** —
the two highest-value data subsystems behind MetaBot. One HTTP server runs on
the internal ECS; every bot (metabot, psi0-elite, beerus, …) talks to it via
a thin CLI client with a per-user Bearer token.

Decoupled from `metabot` itself: metabot installs the CLI from the internal
GitLab npm registry and shells out, no in-tree memory/skill code.

This replaces the 2026-05-15 → 17 in-tree P2P federation + central-server pivot
that was reverted from `metabot/main` on 2026-05-18. The reverted implementation
lives at git tag `archive/p2p-era-end-20260518-main` in the metabot repo and is
the **source we lift code from** rather than rewriting.

## Why this shape (per Flood's call)

1. **Single source of truth on internal ECS.** All memory + skills live on one
   server. No local SQLite, no local cache, no merge problems, no "two truths".
2. **Per-user token = audit boundary.** Each teammate gets one token; every
   read/write is attributable. Admin role (Flood only) for token issuance and
   cross-namespace ops; member role for everyone else.
3. **Pure internal network.** Server lives on 172.31.32.2 behind the existing
   Caddy on `metabot.xvirobotics.com`, mounted at `/core/*`. No public access,
   no separate DNS/TLS work.
4. **Server down ⇒ all bots stop writing memory.** Accepted explicitly — no
   fallback, no degraded mode. If the central is down, fix the central.

## Deployment topology

```
                    Feilian VPN / VPC internal only
                              │
                              ▼
         metabot.xvirobotics.com (172.31.32.2 — existing ECS)
                              │
                              │  Caddy (already running)
                              ▼
   ┌──────────────────────────┴───────────────────────────────┐
   │  handle_path /core/*  → reverse_proxy localhost:9200     │  ← NEW
   │  handle /bp/...       → existing bp worker               │
   │  handle /mail/...     → existing roundcube               │
   │  ...                                                     │
   │  handle {}            → existing default (port 9100)     │
   └──────────────────────────┬───────────────────────────────┘
                              │
                              ▼
                  metabot-core server (this repo)
                  ┌─────────────────────────────┐
                  │  Fastify on localhost:9200  │
                  │                             │
                  │  /memory/*  (metamemory)    │
                  │  /skills/*  (skill hub)     │
                  │  /admin/*   (token mgmt)    │
                  │  /health                    │
                  │                             │
                  │  Bearer auth (sha256 store) │
                  │  Namespace ACL              │
                  │  JSONL audit log            │
                  │                             │
                  │  SQLite + audit logs at     │
                  │  /var/lib/metabot-core/     │
                  └─────────────────────────────┘
                              ▲
                              │ HTTPS Bearer
                              │
   ┌──────────────────────────┴──────────────────────────────┐
   │                                                         │
   │  Bots (metabot, psi0-elite, beerus, …) — each install:  │
   │    npm i -g @xvirobotics/metabot-core                   │
   │    →  /usr/local/bin/mm  (memory CLI)                   │
   │    →  /usr/local/bin/mh  (skill-hub CLI)                │
   │  Plus skills/*.md installed via `mb skills install`.    │
   │                                                         │
   │  Env on each bot host:                                  │
   │    METABOT_CORE_URL=https://metabot.xvirobotics.com/core│
   │    METABOT_CORE_TOKEN=<per-user-token>                  │
   └─────────────────────────────────────────────────────────┘
```

**One server, two endpoints (`/memory`, `/skills`), one SQLite, one audit log.**

## Repo layout

```
packages/
  metamemory/        thin CLI: `mm` — calls /memory/* on the central
    bin/mm.ts        commander entrypoint
    src/             http client, command handlers, output formatting
    test/

  skill-hub/         thin CLI: `mh` — calls /skills/* on the central
    bin/mh.ts
    src/
    test/

  skills/            pure assets, no code
    metamemory/SKILL.md   teaches Claude to use `mm`
    skill-hub/SKILL.md    teaches Claude to use `mh`

  server/            the central server itself
    src/
      server.ts      Fastify bootstrap
      auth/          Bearer middleware, sha256 token store
      acl/           namespace ACL + folder visibility
      audit/         JSONL daily + 100MB rotation, fsync per write
      memory/        /memory/* handlers, SQLite store
      skills/        /skills/* handlers, SQLite store
      admin/         /admin/* handlers — token CRUD, role mgmt
    bin/
      central-admin.ts   admin CLI (issue/revoke/list tokens)
    deploy/
      systemd/metabot-core.service
      caddy/snippet.caddyfile     handle_path /core/* block
      install.sh                  idempotent Ubuntu installer
      bootstrap-admin.sh          first-launch admin token gen
```

Workspace root (this repo) provides shared `tsconfig`, `eslint`, `vitest`, and
the publish pipeline that pushes packages to the GitLab npm registry under
`@xvirobotics/`.

## Phases

Each phase = one PR (or short series) dispatchable to the resident infra team.

### Phase 0 — Bootstrap (DONE, 2026-05-18)
- [x] GitLab repo created at `xvirobotics/metabot-core`
- [x] Deploy key + scaffold (workspaces, gitignore, minimal CI)
- [x] CI runs gitleaks + structure-check

### Phase 1 — Server up on 172.31.32.2 (target: 1 day)

**Goal**: HTTPS-reachable central server at `https://metabot.xvirobotics.com/core/`
behind Bearer auth, with `/health` + admin bootstrap token + `/memory` + `/skills`
endpoints. No CLI yet.

Deliverables:
- `packages/server/` Fastify app listening on `127.0.0.1:9200`
- Bearer middleware, sha256-hashed token store at `/var/lib/metabot-core/tokens.db`
- First-launch generates `mt_admin_<32hex>` to `/var/lib/metabot-core/admin-bootstrap-token.txt` (0600, root-only)
- Endpoints lifted from `archive/p2p-era-end-20260518-main:central/src/`:
  - `GET /memory/folders`, `POST /memory/folders`
  - `GET /memory/documents`, `POST /memory/documents`
  - `POST /memory/search`
  - `GET /skills`, `GET /skills/:name`, `POST /skills` (publish), `POST /skills/:name/install`
  - `GET /admin/tokens`, `POST /admin/tokens`, `DELETE /admin/tokens/:id`
  - `GET /health`
- Systemd unit `metabot-core.service` (Restart=always, hardened: NoNewPrivileges, ProtectSystem=strict, PrivateTmp)
- Caddy snippet committed: `handle_path /core/* { reverse_proxy localhost:9200 }`
- `deploy/install.sh`: idempotent, can be re-run; creates user, dirs, copies systemd unit, reloads Caddy
- Smoke: `curl -H "Authorization: Bearer $TOKEN" https://metabot.xvirobotics.com/core/health` returns `{"ok":true}` from the LAN

**Source**: lift from `archive/p2p-era-end-20260518-main:central/`. Adapt for
new package layout, but port the HTTP shape verbatim — it was reviewed and
shipped via PRs #300–#304 before being reverted.

**Out of scope**: CLI, namespace ACL beyond admin/member, audit log.

### Phase 2 — Audit log + namespace ACL (target: 0.5 day)

**Goal**: every read/write attributable; private folders enforced; insider exfil
threat model intact.

Deliverables:
- Server middleware writes JSONL audit per `/memory/*` and `/skills/*` request:
  `{ts, principalToken, principalName, op, path, params, status}` (no body)
- Daily rotation + 100MB size cap, fsync per write — lifted verbatim from
  `archive/...:central/src/observability/audit-log.ts`
- Folder visibility: `private` / `shared` / `published`; default `private`
- Token model gains `readableNamespaces` + `writableNamespaces`
- Admin (Flood) bypasses namespace ACL but is still audited
- `central-admin audit <YYYY-MM-DD> [--filter principal=X] [--filter op=X]`

**Source**: lift `central/src/observability/audit-log.ts` + visibility filter
from `central/src/memory/memory-store.ts` (was PR #302/#303 in the reverted era).

### Phase 3 — CLI clients `mm` + `mh` (target: 1 day)

**Goal**: thin Node CLIs that bots install from npm and shell out to.

Deliverables:
- `packages/metamemory/` exposes `mm`:
  - `mm read <path>`
  - `mm write <path>` (stdin or `--from-file`)
  - `mm search <query> [--folder] [--peer …no, removed]`
  - `mm list [--folder]`
  - `mm delete <path>`
  - `mm status` (config + last-error)
  - `mm audit <YYYY-MM-DD>` (member sees their own; admin sees all)
- `packages/skill-hub/` exposes `mh`:
  - `mh list`, `mh search <q>`, `mh get <name>`, `mh install <name>`,
    `mh publish <path>`, `mh remove <name>`, `mh status`
- Reads `METABOT_CORE_URL` + `METABOT_CORE_TOKEN` from env or `~/.config/metabot-core/config.toml`
- Friendly error mapping (401, 403, network, server-5xx) — no stack traces
- Exit codes: 0 success, 1 user error, 2 server error, 3 config error
- Bash completion script generated
- Smoke: every command exercised against the live server in CI

**Out of scope**: local cache. There is none.

### Phase 4 — Skills + metabot wiring (target: 1 day)

**Goal**: bots replace in-tree memory/skill code with calls to the CLIs.

Deliverables in this repo:
- `packages/skills/metamemory/SKILL.md` — teaches Claude when/how to call `mm`
- `packages/skills/skill-hub/SKILL.md` — same for `mh`
- Both lifted from current metabot in-tree skill defs and edited for the new
  CLI shape (no `mb memory`/`mb skills`, no peer concepts)

Deliverables in `metabot` repo (separate PR series, gated on this phase):
- Add CLIs as dependencies via the internal GitLab npm registry
- `mb` shell helpers re-implemented to invoke `mm` / `mh` and stream output
- In-tree `src/memory/*` and `src/skills/*` deleted
- Env wired: `METABOT_CORE_URL`, `METABOT_CORE_TOKEN`
- Install new skill `.md` files via `mb skills install`
- Update CLAUDE.md, README.md, README_zh.md
- Smoke against all consumer bots (metabot, psi0-elite, beerus)

### Phase 5 — Migration + cutover (target: 0.5 day + Flood's gate)

**Goal**: every teammate's data living on the central server; in-tree paths cold.

Deliverables:
- `central-admin import` (server-side) reads a tarball of someone's existing
  `data/metamemory.db` + `data/skill-hub.db`, writes to central under their
  namespace
- Per-teammate workflow: ship me your dbs → I import → I hand back token → you
  flip env on your bot → smoke read+write → tear down local dbs
- Flood goes first as the canary
- Until everyone is migrated, server is up but only Flood is using it
- Gate: Flood says "cut over" after his own 24h soak

### Phase 6 — Polish (rolling)
- Per-token rate limiting (default 100 req/min, admin: unlimited)
- Backup automation: `restic` push of SQLite + audit log to OSS internal bucket
- Disaster recovery procedure documented in `docs/dr.md`
- Onboarding doc lifted from earlier Feishu draft, into `docs/onboarding.md`
- Observability: `/metrics` Prometheus-format, latency p50/p95, error rate
- (Maybe) per-folder write-quota

## What does NOT change

- metabot stays at `2c13192` until Phase 4 lands. Existing in-tree memory/skill
  code keeps working for everyone, on every bot, for the entire build window.
- No bot working directory or running config touched until Phase 4–5.
- Caddy, mysql, redis, mail stack on 172.31.32.2 left alone — we add one
  `handle_path` block, that's it.

## Settled by Flood (2026-05-18)

1. **Port**: `9200` on `127.0.0.1`. ✓
2. **Data path**: `/vepfs/users/floodsung/metabot-core-data/`
   (under vepfs for easy backup; NOT under `/var/lib/`). ✓
   Subdirs: `tokens.db`, `memory.db`, `skills.db`, `audit/YYYY-MM-DD.jsonl`,
   `admin-bootstrap-token.txt` (mode 0600).
3. **systemd user**: runs as `floodsung` (not a dedicated system user).
   This means `User=floodsung` in the unit file; data dir is owned by
   `floodsung:floodsung`. ✓
4. **GitLab npm registry token**: Flood will issue it when Phase 3 needs
   it; no separate ping to trunks. ✓

## Still open

- **Phase 4 cutover window** — needs a quiet day for metabot. Probably the
  weekend after Phase 3 lands. Flood will pick the day.

## Dispatch model

Phases 1–3 happen in this repo (`metabot-core`) — engineers work in
`/vepfs/users/floodsung/metabot-workspace/metabot-core/`. PR target is `main`
of `xvirobotics/metabot-core` on internal GitLab.

Phase 4 (the metabot-side wiring) happens in the `metabot` repo on GitHub.

Phase 5 deploy/migration runs from this host (172.31.32.2). I have sudo here,
so the deploy itself doesn't need trunks. Trunks gets pinged only for the
GitLab npm registry publish token (Phase 3 prep).

## Timeline (autonomous, sequential)

- Phase 1: 1 day
- Phase 2: 0.5 day
- Phase 3: 1 day
- Phase 4: 1 day (this is the breaking change for metabot)
- Phase 5: 0.5 day + Flood's gate
- Phase 6: rolling

**Total to production**: ~4 days of build + Flood's 24h canary on the central.
