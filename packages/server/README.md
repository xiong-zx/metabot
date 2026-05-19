# @xvirobotics/metabot-core-server

Centralized memory + skill-hub HTTP server for the MetaBot team. Single
process, single SQLite, single bind on `127.0.0.1:9200` behind a dedicated
Caddy host block on `metabot-core.xvirobotics.com` (post P4-MR6 domain
pivot — bare root, no path prefix, single-host header-routed shape; see
`deploy/caddy/snippet.caddyfile`). The shared multi-tenant
`metabot.xvirobotics.com` host is unrelated to this deploy and left
untouched; only its legacy `/core` sub-handle is preserved for old CLI
configs.

This package was lifted from the metabot repo's
`archive/p2p-era-end-20260518-main:central/` tree and adapted to live in
metabot-core's workspace layout. Same API, same SQLite schema, same auth
model — only env-var names and defaults changed.

## Quick start (dev)

From the metabot-core repo root:

```bash
npm install                                  # workspace install
npm -w @xvirobotics/metabot-core-server build
npm -w @xvirobotics/metabot-core-server test
METABOT_CORE_DATA_DIR=/tmp/mc-dev \
  node packages/server/dist/index.js
```

On first start the server bootstraps an admin credential and writes the
one-time bearer token to `<data-dir>/admin-bootstrap-token.txt` (mode 0600).
Save it — it is never displayed again.

## Configuration (env)

| Var | Default | Notes |
|---|---|---|
| `METABOT_CORE_HOST` | `127.0.0.1` | Bind address. Loopback-only by default — Caddy fronts it. |
| `METABOT_CORE_PORT` | `9200` | TCP port. |
| `METABOT_CORE_DATA_DIR` | `/vepfs/users/floodsung/metabot-core-data` | SQLite + audit live here. |
| `METABOT_CORE_AUDIT_DIR` | `$METABOT_CORE_DATA_DIR/audit` | Override audit dir. |
| `METABOT_CORE_AUDIT_ENABLED` | `true` | Set `false` to disable audit writes. |
| `METABOT_CORE_INSTANCE_NAME` | _pkg name_ | Surfaced in `/api/manifest`. |
| `METABOT_CORE_UI_HOST` | _unset_ | Hostname that triggers the SPA Web UI fall-through. See "Web UI" below. Unset → API-only. |
| `METABOT_CORE_UI_ALLOWED_EMAILS` | _unset_ | Comma-separated email whitelist for browser SSO (oauth2-proxy → `X-Forwarded-Email`). Lowercased + trimmed. Unset/empty → web-identity disabled. See "Browser SSO identity" below. |
| `LOG_FORMAT` | _auto_ | `json` for prod; defaults to `pino-pretty` on a TTY. |
| `LOG_LEVEL` | `info` | pino level. |

## API

Open routes (no auth):

```
GET  /health          → { ok, uptime, version }
GET  /api/manifest    → { schemaVersion, instance, capabilities }
```

Authenticated routes use `Authorization: Bearer <token>`. Admin routes
(`role: 'admin'`):

```
POST   /admin/credentials/issue
POST   /admin/credentials/revoke
GET    /admin/credentials
GET    /admin/audit?date=YYYY-MM-DD[&principal=&op=]
```

Memory routes:

```
GET    /api/memory/folders[?prefix=/users/...]
GET    /api/memory/folders/tree
GET    /api/memory/folders/:idOrPath
POST   /api/memory/folders
DELETE /api/memory/folders/:idOrPath
GET    /api/memory/documents[?folder_id=|prefix=&limit=&offset=]
POST   /api/memory/documents
GET    /api/memory/documents/:idOrPath
PATCH  /api/memory/documents/:idOrPath
DELETE /api/memory/documents/:idOrPath
GET    /api/memory/search?q=&limit=
```

Skill routes:

```
GET    /api/skills
GET    /api/skills/search?q=
GET    /api/skills/:name
POST   /api/skills/:name/publish      ← requires publishSkill or admin
DELETE /api/skills/:name              ← admin only
```

Paths may be referenced as either internal id (uuid) or absolute path
starting with `/`. The router URL-decodes the segment, so e.g.
`/api/memory/documents/%2Fusers%2Fdkj%2Fnotes%2Fhello` resolves the
document at `/users/dkj/notes/hello`.

### Document `content_type`

Documents carry a `content_type` field. v1 whitelist:

- `text/markdown` (default when omitted)
- `text/html`

`POST` / `PATCH` / `PUT` accept an optional `content_type` in the request
body; unknown values → `400 unsupported_content_type`. Existing databases
get the column added on first boot via an idempotent migration; all
pre-existing documents default to `text/markdown`. The capability is
advertised on `/api/manifest` as
`capabilities.content_types: ["text/markdown", "text/html"]` so clients
can feature-detect.

FTS still indexes raw `content`, so HTML documents are searchable by both
their tags and text. Snippet rendering may include `<mark>` tags inside
HTML markup — acceptable for v1; not in scope to fix here.

## Web UI (host-based dispatch)

The server can also serve a single-page Web UI built from a sibling repo
(scaffolded separately; assets land in `packages/server/static/`). Serving
is **opt-in and host-gated**:

- Set `METABOT_CORE_UI_HOST=<hostname>` (e.g. `metabot-core.xvirobotics.com`
  post P4-MR6 domain pivot). The check is case-insensitive and ignores port.
- Only `GET` requests whose `Host` header matches `METABOT_CORE_UI_HOST`
  fall through to `packages/server/static/`. POST/PATCH/DELETE/etc. on
  non-API paths still return `404` even on the UI host — static-serve never
  accepts uploads.
- Requests on any other host (including the API host) continue to behave
  as a pure API server (`404 not_found` for paths outside `/api/*` and
  `/admin/*`).
- `/health` and `/api/manifest` stay reachable on the UI host so the SPA
  can self-bootstrap.
- Assets under `/assets/*` are served with
  `Cache-Control: public, max-age=31536000, immutable`; everything else
  (including `index.html` and the SPA fallback) uses `Cache-Control: no-cache`.
- Unknown paths fall back to `index.html` (SPA routing). If `index.html`
  is missing the response is `404 ui_not_installed` — install the UI bundle
  separately (a dedicated install step lands in a follow-up).
- Defense-in-depth: traversal attempts are stopped by `node:URL`
  normalization plus a `path.resolve()` boundary check against
  `STATIC_DIR`. The MIME map is an allowlist
  (`.html`, `.js`, `.css`, `.svg`, `.ico`, `.map`, `.png`, `.jpg`, `.jpeg`,
  `.woff2`, `.json`); anything else falls back to `application/octet-stream`.

Default unset → the SPA path is dormant and the server behaves as an API-
only server. To enable in production, set the env var in
`/etc/metabot-core/env` and restart `metabot-core`. Post P4-MR6 this
points at the dedicated `metabot-core.xvirobotics.com` host that Caddy
terminates via its own additive host block.

## Browser SSO identity (web-identity)

For the browser SPA, the server accepts a second auth chain alongside the
CLI/bot Bearer path: an `X-Forwarded-Email` header injected by a trusted
oauth2-proxy (飞连 OIDC) in front of the server. This is **opt-in and
default-off**, gated by `METABOT_CORE_UI_ALLOWED_EMAILS`.

- **Bearer always wins.** The web path is only entered when there is *no*
  `Authorization: Bearer` header. A forged `X-Forwarded-Email` cannot
  downgrade or impersonate a real token.
- **Whitelist.** `METABOT_CORE_UI_ALLOWED_EMAILS` is a comma-separated
  list, lowercased + trimmed at load. The inbound `X-Forwarded-Email` is
  lowercased before the membership check (case-insensitive). Empty/unset →
  the email header is ignored entirely and the server is Bearer-only.
- **Synthetic credential.** A whitelisted email mints an in-memory,
  never-persisted credential: `id: web:<email>`, `role: member`,
  `readableNamespaces: ['/']` (full read), `writableNamespaces: []`,
  `publishSkill: false`, `synthetic: true`, `authSource: 'web'`.
- **Structural read-only fork (primary gate).** A web identity can ONLY
  reach these GET routes; **everything else returns `404 not_found`**
  (not 403 — route existence is not leaked):
  - `GET /api/memory/folders`, `/api/memory/folders/tree`,
    `/api/memory/folders/:idOrPath`
  - `GET /api/memory/documents`, `/api/memory/documents/:idOrPath`
  - `GET /api/memory/search`
  - `GET /api/skills`, `/api/skills/search`, `/api/skills/:name`
  - (`/health`, `/api/manifest` are open to everyone)
  Defense-in-depth: (1) the structural route fork, (2) `role:member` +
  empty `writableNamespaces`, (3) the email whitelist env.
- **Auth failures.** `X-Forwarded-Email` missing (and no Bearer) →
  `401 missing_token`; present but not whitelisted →
  `403 web_identity_forbidden`.
- **Audit.** Web requests log `credentialId=web:<email>`, `role=member`,
  plus `authSource:'web'` — greppable without overloading the ACL role
  enum.

oauth2-proxy on the single-host deploy enforces OIDC on `/api/*` via
`api_routes` (returns `401` on unauthenticated XHR while still injecting
`X-Forwarded-Email` on authenticated sessions); `/api/manifest` and
`/ping` stay in `skip_auth_routes`. CLI/bot Bearer traffic bypasses
oauth2-proxy entirely — Caddy steers `Authorization: Bearer*` requests
straight to the backend via an `@bearer` matcher on the same host (see
`deploy/caddy/snippet.caddyfile`). Ops detail in
`docs/internal/web-ui-arch.md` §11.6 and
`deploy/oauth2-proxy/oauth2-proxy-metabot-core.cfg` (the new :4182 unit;
the legacy `oauth2-proxy-mbcore.cfg` on :4180 stays in place for the 24h
soak of `metabot-core-ui.xvirobotics.com`).

## ACL

```
canRead(cred, path):
  admin → true
  /shared/* → true
  cred.readableNamespaces matches → true
  otherwise false

canWrite(cred, path):
  admin → true
  cred.writableNamespaces matches → true
  otherwise false

canPublishSkill(cred):
  admin → true
  cred.publishSkill → true
  otherwise false
```

Defaults when issuing a member:
- `writableNamespaces`: `[/users/<botName>]`
- `readableNamespaces`: `[/shared, /users/<botName>]`
- `publishSkill`: false

## CLI: `central-admin`

```
central-admin issue   --bot <name> --owner <name> [--role admin|member]
                      [--writable <ns,ns>] [--readable <ns,ns>]
                      [--publish-skill] [--notes <text>]
central-admin revoke  --id <credentialId>
central-admin list
central-admin audit   --date YYYY-MM-DD [--principal <id>] [--op <op>]
```

Auth: `METABOT_CORE_ADMIN_TOKEN` env or `--token <token>`. URL via
`METABOT_CORE_URL` (default `http://localhost:9200` for the admin CLI, which
runs on the deploy host; the client CLIs default to
`https://metabot-core.xvirobotics.com`) or `--url`.

## Deployment

See `deploy/`:

- `systemd/metabot-core.service` — systemd unit (User=floodsung,
  WorkingDirectory=/vepfs/users/floodsung/metabot-core-data, hardened with
  NoNewPrivileges + ProtectSystem=strict + PrivateTmp + ReadWritePaths)
- `caddy/snippet.caddyfile` — standalone `metabot-core.xvirobotics.com { ... }`
  host block (single-host header-routed shape: `@bearer` → backend direct,
  fallthrough → oauth2-proxy → backend with X-Forwarded-Email). Pure-additive
  append to `/etc/caddy/Caddyfile`; does NOT touch the shared multi-tenant
  `metabot.xvirobotics.com` block. Supersedes the predecessor
  `metabot-core-ui.xvirobotics.com` host (retiring 24h post-cutover).
- `oauth2-proxy/oauth2-proxy-metabot-core.cfg` — oauth2-proxy config for
  the `metabot-core.xvirobotics.com` Feilian OIDC chain. Binds
  `127.0.0.1:4182`. Cookie name `_mbportal_oauth2_proxy`. OIDC
  client_id/client_secret live in `/etc/feilian/metabot_core_oidc.env`
  (Feilian app 5653); cookie_secret in `/etc/oauth2-proxy-metabot-core/cookie.env`
  (fresh + independent so it can be rotated on its own). Bare `^/api/` in
  `api_routes`; SOLE gate is `email_domains = ["xvirobotics.com"]`.
- `systemd/oauth2-proxy-metabot-core.service` — systemd unit for the
  :4182 oauth2-proxy instance.
- `systemd/metabot-core-cert-renew.{timer,service}` — daily certbot renew
  (DNS-01) + Caddy reload via the shared `/etc/caddy/certbot-hooks/deploy.sh`.
  Required because Caddy on this host lacks the DNS-01 ACME module and the
  domain is RFC1918 (飞连 VPN-only).
- `install.sh` — idempotent installer. Run after `npm install && npm run
  build` from the package dir. Installs the metabot-core unit, enables +
  starts the service. Does NOT touch Caddy, oauth2-proxy, or certbot —
  those are separate orchestrator steps (see the install.sh "Next steps"
  echo).

## Tests

`npm test` runs the full vitest suite:

- `tests/auth.test.ts` — credential issue/revoke/lookup/cache + bootstrap
- `tests/memory.test.ts` — folder + document CRUD with namespace ACL
- `tests/skills.test.ts` — publish/list/search/delete + publish-acl
- `tests/audit.test.ts` — every authed request logged JSONL
- `tests/e2e.test.ts` — full flow over real HTTP: bootstrap → issue → member
  writes own ns / 403 elsewhere → revoke
