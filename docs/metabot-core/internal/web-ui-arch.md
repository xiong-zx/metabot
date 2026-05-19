# metabot-core Web UI — Architecture Spec

Status: APPROVED — 2026-05-18. Read-only MVP. Writes stay on `mm` CLI.

## 1. Goal

A browser UI to read meta-memory + skill-hub from a laptop on the intranet (飞连 VPN), with **HTML as a first-class document storage format** alongside Markdown. HTML is expected to become the dominant memory format over time (LLM-generated dashboards, structured reports, embedded charts), so the schema and renderer must treat it natively — not as an attachment.

Non-goals (deferred):
- In-browser create/edit/delete (Phase 2).
- Public exposure.
- Mobile/responsive polish beyond "doesn't break".
- Multi-tenant theming.

## 2. Topology

P4-MR6 (2026-05-19) pivoted the front-door domain to dedicated
**`metabot-core.xvirobotics.com`** (dash between `metabot` and `core`).
Both the browser SPA and the `metabot` CLI default canonically point at
this host. The shared multi-tenant `metabot.xvirobotics.com` host is NOT
touched by this deploy (it hosts ~10 unrelated sub-handles owned by several
teams — `/slam-video`, `/droidw-viz`, `/nav-viz`, `/pipeline`, `/seedance`,
`/bp`, `/dreamfactory`, `/core`, …). The legacy `/core` sub-handle is left
in place, so CLIs explicitly configured against
`https://metabot.xvirobotics.com/core` keep working unchanged.

```
laptop (飞连 VPN) ─┐
bot host         ─┴─→ metabot-core.xvirobotics.com (172.31.32.2)
                          │  Caddy (dedicated host block, additive — does
                          │   NOT touch the shared metabot.xvirobotics.com)
                          ├── @bearer (Authorization: Bearer*)
                          │     → reverse_proxy 127.0.0.1:9200 (backend direct, no SSO)
                          │
                          └── default
                                → reverse_proxy 127.0.0.1:4182 (oauth2-proxy-metabot-core → Feilian OIDC)
                                    → backend with X-Forwarded-Email

backend (packages/server) on 127.0.0.1:9200
  ├── /                     → SPA shell (index.html), served only on the UI host
  ├── /assets/*             → JS/CSS bundles
  └── /api/*, /admin/*      → existing JSON API (Bearer OR web-identity)
```

One dedicated host, one cookie domain, one origin. CLI/bot traffic carries
an `Authorization: Bearer …` header and goes straight to the backend (no
SSO cookie, no Feilian); browser traffic carries no Bearer and traverses
oauth2-proxy (Feilian OIDC) which injects `X-Forwarded-Email`. The Caddy
`@bearer` matcher is load-bearing — a misconfig either 302s automation into
Feilian or lets anonymous browser traffic reach :9200 un-gated.

The predecessor `metabot-core-ui.xvirobotics.com` host (Model B dual-host
setup, see `decision_metabot_core_ui_intranet_ops`) was hard-cut at
cutover — DNS + cert + Caddy block all removed. No redirect: by owner
decision the only canonical front door going forward is
`metabot-core.xvirobotics.com`. The standalone `t5t.xvirobotics.com` host
was hard-cut at the same time; `metabot-core.xvirobotics.com/t5t` is now
the only address.

## 3. Schema migration

Single new column on `documents`:

```sql
ALTER TABLE documents ADD COLUMN content_type TEXT NOT NULL DEFAULT 'text/markdown';
```

- Idempotent: must run inside `MemoryStore.initSchema()` via a guarded `PRAGMA table_info(documents)` check, **not** `CREATE TABLE`. Add the column on first boot after the upgrade; all 297+ existing docs inherit `text/markdown`.
- Allowed values for v1: `text/markdown`, `text/html`. Anything else → reject at the route layer with 400 `unsupported_content_type`. The whitelist lives in `memory-store.ts` (single source of truth) and is also exported for use by routes + CLI.
- No FTS schema change. `documents_fts` continues indexing raw `content` as-is — for HTML docs this means the user can full-text-search the HTML source (tags + text). Stripping tags before indexing is a Phase 2 nicety; not in scope.

### Back-compat rule

Every existing API response that returned `Document` now also returns `content_type`. Existing CLIs that read JSON and ignore unknown fields are unaffected. Server keeps accepting requests **without** `content_type` (defaults to `text/markdown`).

## 4. API surface change

Field name: **`content_type`** (snake_case, matching existing `created_by` / `folder_id`).

### Documents — request

| Endpoint | Change |
|---|---|
| `POST /api/memory/documents` | Body accepts optional `content_type: "text/markdown" \| "text/html"`. Default `text/markdown`. Validated against whitelist. |
| `PATCH/PUT /api/memory/documents/:idOrPath` | Body accepts optional `content_type`. If supplied, validated and persisted; if omitted, content_type is left unchanged. |

### Documents — response

`Document`, `DocumentSummary`, and `SearchResult` JSON gain a `content_type` field. Yes, even `SearchResult` — the UI uses it to decide whether to render the snippet as HTML or text.

### Manifest

`GET /api/manifest` capabilities object gains `content_types: ["text/markdown", "text/html"]`. Lets the SPA feature-detect rather than hardcode.

### Skills — gap check

`GET /api/skills/:name` already returns the full `SkillRecord` (incl. `skillMd`). Verify in MR-B; if `skillMd` is missing from the response, add it. No new endpoints needed.

## 5. mm CLI delta

Tiny, additive:

```
mm create <title> [content] [--folder <id>] [--tags a,b,c] [--by <name>] [--html | --content-type <mime>]
mm update <doc_id> [content] [--title <t>] [--tags a,b,c] [--html | --content-type <mime>]
```

Rules:
- `--html` is sugar for `--content-type text/html`. Conflicts with `--content-type` → exit 2.
- `--content-type` accepts only whitelist values; server rejects unknowns anyway, but client-side fail-fast helps the UX.
- **Auto-detection from a path arg is out of scope** for this round (no `.html` extension sniffing on positional content). Reason: positional `content` is the literal content string, not a filename. If we add `mm create --from-file foo.html` later, auto-detect can live there.
- Roundtrip smoke (MR-A definition of done): `echo '<h1>hi</h1>' | mm create test-html --html` → `mm get <id>` shows `content_type: "text/html"` and `content: "<h1>hi</h1>\n"`.

## 6. Host dispatching

Server config gains one env var:

- `METABOT_CORE_UI_HOST` (optional, default unset) — the hostname that serves the SPA. When unset, the SPA + static assets are not served at all (defensive default, API-only deploy). Post-P4-MR6 this is set to `metabot-core.xvirobotics.com` (the dedicated front-door domain).

Dispatch logic in `server.ts`:

```ts
const uiHost = process.env.METABOT_CORE_UI_HOST?.toLowerCase();
const reqHost = (req.headers.host || '').split(':')[0].toLowerCase();
const isUiHost = !!uiHost && reqHost === uiHost;

// 1. /api/*, /admin/*, /health, /api/manifest — served on ALL hosts (unchanged behavior).
// 2. /, /assets/*, anything else — served ONLY when isUiHost; otherwise 404.
```

Rationale:
- Header-based, not port-based: the same backend serves both browser SPA loads and CLI/admin API traffic; the `Host` check just refuses to fall through to SPA static-serve on unintended hosts (e.g. raw `127.0.0.1` probes from inside the box, or a future second vhost).
- Default-off: someone running a stock metabot-core install without setting the env var gets the current behavior (404 for `/`). No surprise SPA.
- Trust model: defense in depth. The actual perimeter is Caddy + Feilian SSO (browser path) or Caddy + Bearer (CLI path). The `METABOT_CORE_UI_HOST` check is a belt to go with the suspenders.

## 7. SPA packaging

**Decision**: separate workspace package `packages/web-ui/`, build artifact copied into `packages/server/static/`.

```
metabot-core/
  packages/
    server/
      static/              ← build artifact, gitignored, server reads from here
        index.html
        assets/*.js,*.css
      src/
        server.ts          ← serves static/ when on UI host
    web-ui/                ← NEW
      package.json         (private, "build": "vite build --outDir ../server/static")
      vite.config.ts
      tsconfig.json
      index.html
      src/
        main.tsx
        App.tsx
        routes/
          login.tsx
          home.tsx
          memory-path.tsx
          skills-list.tsx
          skill-detail.tsx
          search.tsx
        lib/
          api.ts           (fetch wrapper, reads token from localStorage)
          token.ts
          render-markdown.ts
          render-html.ts   (sandboxed iframe srcdoc)
        styles/
```

Why separate package, not inside `server/`:
- `npm run build` at repo root already iterates workspaces; web-ui builds before/independent of server.
- Keeps server's Node deps clean — no Vite/React in server's `node_modules`.
- `static/` is a build product, gitignored at the package root: `packages/server/static/`. Server gracefully no-ops (404 on `/`) if the dir is missing.

Rejected alternative: build into `packages/server/src/static-bundle.ts` as an embedded base64 blob. Wins nothing, complicates rebuilds, breaks browser source maps.

### Server static-serving

Minimal hand-rolled: when `isUiHost && method === 'GET' && !startsWith('/api') && !startsWith('/admin') && !startsWith('/health')`, resolve the file under `static/`. Block path traversal (`..`). Default to `index.html` for unknown paths so SPA routing works. Set `Cache-Control: no-cache` on `index.html`, `Cache-Control: public, max-age=31536000, immutable` on `/assets/*` (Vite outputs hashed filenames).

Routes (SPA):
- `/login` — token paste form, writes to `localStorage['metabot-core-token']`.
- `/` — folder tree + recent docs.
- `/memory/*path` — folder browser + doc viewer (path-keyed, deep-linkable).
- `/skills` — list.
- `/skills/:name` — SKILL.md rendered + metadata sidebar.
- `/search?q=...` — unified search across memory + skills.

### HTML rendering

```tsx
<iframe
  srcdoc={doc.content}
  sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
  style={{ width: '100%', minHeight: '60vh', border: 0 }}
/>
```

`allow-scripts` is **deliberately omitted** — even though the source is trusted intranet content, treating stored HTML as "data not code" buys us a free safety net if an LLM-generated doc embeds something bad. If a user complains they need JS in a memory doc, revisit.

Markdown: `marked` + `DOMPurify` inline (no iframe). DOMPurify before injecting via `dangerouslySetInnerHTML`.

## 8. install.sh delta

`packages/server/deploy/install.sh` needs one additional rsync step **after** the existing `dist/` rsync:

```bash
if [[ -d "$PKG_DIR/static" ]]; then
  echo "==> Syncing web UI static assets to $INSTALL_DIR/static"
  rsync -a --delete "$PKG_DIR/static/" "$INSTALL_DIR/static/"
fi
```

Server reads `static/` relative to the package root (resolved from `import.meta.url`), so the deploy-time path matches the dev-time path.

`/etc/metabot-core/env` gains one line (only when first creating the file):

```
METABOT_CORE_UI_HOST=metabot-core.xvirobotics.com
```

For hosts upgrading from an older install, the line is **not** added retroactively (env file is idempotent / never overwritten). The operator edits the existing file manually + restarts. Documented in the install script's final "Next steps" echo.

P4-MR6 (2026-05-19) pivoted this default to the dedicated front-door domain
`metabot-core.xvirobotics.com`. Earlier values seen on existing hosts:
`metabot-core-ui.xvirobotics.com` (pre-P4-MR3 split-DNS dual-host) or
`metabot.xvirobotics.com` (the brief P4-MR3/MR5 window that targeted the
shared multi-tenant host before the pivot). Hosts that still carry a legacy
value need a one-line manual edit; the install script does not rewrite an
existing env file.

## 9. PR sequencing

| MR | Owner | Touches | Smoke |
|---|---|---|---|
| **A** | backend-engineer | migration, memory-store, memory-routes, manifest, metamemory CLI, tests | mm roundtrip HTML doc + unit tests |
| **B** | backend-engineer | server.ts host-dispatch, static-serve helper, skill-routes gap-check, env-var docs | curl with `Host:` header serves SPA fallback; default host returns 404 for `/` |
| **C** | frontend-engineer | new `packages/web-ui/` workspace, install.sh delta, README docs | `npm run build`; manual `curl /` returns shell; manual VPN walkthrough |
| **D** | qa-reliability | regression tests + end-to-end VPN smoke | full checklist (see CLAUDE.md) |

Parallelizable after C merges: ops side (DNS + Caddy + cert) runs alongside D. Originally targeted the now-retired `metabot-core-ui.xvirobotics.com` host; collapsed onto bare-root `metabot.xvirobotics.com` in P4-MR3 and finalized in P4-MR5.

## 10. Open questions (defer or decide-later)

- **Bundle size budget**: not enforced in v1. Revisit if shell > 500 KB gzipped.
- **i18n**: English-only labels in v1. The doc *content* is whatever the user wrote (mixed CN/EN already works). The UI chrome is small — re-skinning later is cheap.
- **Audit-log filter for SPA traffic**: SPA hits `/api/*` like any client, so it's already audited. No additional surface.
- **Per-user view tracking / favorites**: out of scope. Stateless reader.

---

# 11. Auth pivot — Model A → Model B (飞连 OIDC SSO)

Status: PLAN FINALIZED 2026-05-18 — Model B shipped (see
`decision_metabot_core_model_b_shipped` memory). The section below documents
the auth architecture as designed. **P4-MR3 (2026-05-18) subsequently
collapsed the host topology from dual-host (`metabot-core-ui.xvirobotics.com`
for browser + `metabot.xvirobotics.com/core` for CLI) to single-host bare-root
(`metabot.xvirobotics.com`) with Caddy header-routing.** The identity model,
synthetic-credential design, structural read/write fork, audit-log
discriminator, and `email_domains=["xvirobotics.com"]` gate all carry over
unchanged. The only delta is the topology section: there is now ONE host
serving both auth chains, with the Caddy `@bearer` matcher steering Bearer
traffic past oauth2-proxy. See §2 for the post-P4-MR3 topology diagram and
the P4-MR3 MR description for the live-flip runbook. Mentions of
`metabot-core-ui.xvirobotics.com` below are historical and refer to the
pre-P4-MR3 split-DNS deploy.

Recipe source: verified t5t production config (memory `decision_metabot_core_model_b_feilian_oidc`).

## 11.1 Identity model

Two independent auth chains, same `Credential` shape downstream:

- **CLI/bot (unchanged)**: `Authorization: Bearer` → `authenticate()` → real persisted Credential. Untouched by this work.
- **Browser (new)**: oauth2-proxy injects `X-Forwarded-Email` (and strips any client-forged `X-Forwarded-*` at the edge). Backend mints an **in-memory synthetic Credential** — never persisted, no token:
  - `id: 'web:' + email`
  - `botName: email`
  - `role: 'member'` ← **real enum value; drives ACL correctly. Do NOT invent `role:'web'`.**
  - `readableNamespaces: ['/']` (whitelisted single user sees the whole archive)
  - `writableNamespaces: []` (belt — even a logic slip can't write)
  - `publishSkill: false`
  - `synthetic: true` + `authSource: 'web'` ← **new optional fields, the audit/observability discriminator. Nothing ACL-keyed reads these.**

## 11.2 Why a structural GET-only fork (the crux)

`canReadPath`/`canWritePath`/`requireAdmin`/`publish-acl` all switch on `cred.role`. We deliberately keep the synthetic cred at `role:'member'` with `readableNamespaces:['/']` so reads work and writes are namespace-denied. **But ACL alone is not the gate.** The real gate: `server.ts` decides auth *source* FIRST, then a hard structural fork — if source=web, only the explicitly enumerated read-only GET routes are even dispatched; write/admin/DELETE/PATCH/POST handlers are never entered. Defense in depth, three layers: (1) structural route fork, (2) `role:'member'` + empty writable namespaces, (3) backend email whitelist env.

## 11.3 Audit discriminator (resolved)

Confirmed by reading `observability/audit-log.ts`: `AuditEntry.role` is free-form `string` (line 23); `AuditLog.read()` filters only on `credentialId` + `op` (lines 136-137) — **nothing in the audit layer switches on `role`'s value**. `server.ts:323` currently sets the audited `role` from `cred.role`. Resolution: keep auditing `cred.role` (= `'member'` for web), and additionally emit the new `authSource:'web'` / `synthetic:true` as the browser-vs-CLI discriminator. We do NOT overload `role` with a `'web'` value, because `cred.role` is the ACL enum and widening it risks a role-keyed code path. `credentialId` in the audit line is already distinct (`web:<email>`), so browser traffic is greppable without touching `role`.

## 11.4 Risk #2 — RESOLVED: oauth2-proxy `api_routes` enforces OIDC on the API, returns 401 (not 302) on XHR, SPA hard-redirects

**Premise correction (2026-05-18, design reconciliation).** The earlier "skip_auth_routes for the API + SPA-driven redirect" plan came from the t5t recipe, where t5t is single-host (CLI + browser both traverse oauth2-proxy → CLI must skip OIDC). Our deployment is **two-host**:

- **CLI/bot** → public `metabot.xvirobotics.com/core` (existing Caddy, **no oauth2-proxy**). `mm`/`mh` default `METABOT_CORE_URL=https://metabot.xvirobotics.com/core`; admin-cli defaults to localhost.
- **Browser** → `metabot-core-ui.xvirobotics.com` → Caddy → oauth2-proxy → backend. **Only browsers traverse oauth2-proxy on this host.**

Therefore t5t's `^/api/cli/` skip pattern does NOT transfer; there is no CLI traffic to bypass here. On the UI host, oauth2-proxy should **enforce OIDC on `/api/*`**, not skip it.

**oauth2-proxy v7.9.0 mechanism (verified from source — see report below):**

- `skip_auth_routes` does NOT prevent header injection on valid sessions. `getAuthenticatedSession` in `oauthproxy.go` has the comment *"Check this after loading the session so that if a valid session exists, we can add headers from it"* — the session loader (`StoredSessionLoader` middleware) runs unconditionally, and `headersChain` (which injects `X-Forwarded-*`) runs in the `case nil` branch that allow-listed routes fall through. So skip_auth + valid cookie → headers ARE injected. The earlier worry that "skip_auth → no headers" is incorrect for v7.9.
- `api_routes` (path regex) makes oauth2-proxy return **HTTP 401 (not 302)** for unauthenticated requests, AND still loads session + injects headers when the session is valid. From the v7.9 docs table: *"Requests to these paths must already be authenticated with a cookie, or a JWT if `--skip-jwt-bearer-tokens` is set. No redirect to login will be done. Return 401 if not."* This is exactly what an XHR-driven SPA needs.

**Decision (locked):** Use `api_routes` (NOT `skip_auth_routes`) for the API. The /api/* prefixes are **removed from `skip_auth_routes`** and **added to `api_routes`**. Result:
1. Authenticated browser API call → headers injected → backend reads `X-Forwarded-Email` → 200.
2. Unauthenticated browser API call → oauth2-proxy returns 401 (not 302) → SPA's `fetch` catches it → SPA does `window.location.href='/oauth2/sign_in?rd=…'` → user lands on Feilian.
3. SPA shell/static (HTML, JS, CSS, asset bundles) → guarded by oauth2-proxy default flow (302→Feilian for unauth) — that's correct for full-page loads.
4. CLI traffic is unaffected (different host, no oauth2-proxy in the path).

This is still "SPA-driven redirect" (the SPA, not oauth2-proxy, decides where to send an unauth user — matching t5t's UX), but with the cleaner mechanism: oauth2-proxy returns the catchable 401 explicitly via `api_routes`, instead of the route being skipped and the backend returning 401 by virtue of header absence. Both work; `api_routes` is unambiguously better because (a) it prevents anonymous browser traffic from reaching the backend at all (defense in depth), (b) the 401 contract is owned by oauth2-proxy and doesn't depend on backend route enumeration being exhaustive, (c) v7.9 documents this behavior explicitly so it's stable across patch versions.

## 11.5 PR plan — 2 MRs, serial (HELD)

### MR-D1 — backend web-identity + route gating (→ backend-engineer)
- `auth/auth-middleware.ts`: add `authenticateWeb(req, allowedEmails): AuthResult` — case-insensitive `X-Forwarded-Email` lookup, lowercase, whitelist check, return synthetic Credential or `{status:401}` (missing) / `{status:403}` (not whitelisted). `authenticate()` (Bearer) untouched.
- `auth/credentials.ts`: add optional `synthetic?: true` + `authSource?: 'web' | 'bearer'` to the `Credential` interface. No behavior change for existing code (optional fields).
- `server.ts`: after open routes (`/health`, `/api/manifest`), try Bearer first; if no Bearer AND `X-Forwarded-Email` present → web path. **Bearer always wins when both present** (web path only entered when no Bearer — prevents a forged header from downgrading a real token). Hard fork: web identity → only these reachable, everything else 404 (not 403, don't leak route existence):
  - `GET /api/memory/folders`, `/api/memory/folders/tree`, `/api/memory/folders/:idOrPath`
  - `GET /api/memory/documents`, `/api/memory/documents/:idOrPath`
  - `GET /api/memory/search`
  - `GET /api/skills`, `/api/skills/search`, `/api/skills/:name`
  - (`/health`, `/api/manifest` already open to all)
- `index.ts` (ServerOptions build): read `METABOT_CORE_UI_ALLOWED_EMAILS` (comma-sep, lowercased). Unset/empty → web-identity disabled entirely (default-off, same posture as `METABOT_CORE_UI_HOST`). Pass through `ServerOptions`.
- Audit: web requests audit `credentialId='web:'+email`, `role='member'`, plus `authSource:'web'`.
- Tests: whitelisted→GET 200; whitelisted→POST/PATCH/DELETE/admin→404; not-whitelisted→403; no-email+no-Bearer→401; Bearer path regression green; env unset→email ignored; forged email + valid Bearer → Bearer wins.
- **Additive + default-off → safe to merge anytime before ops flips oauth2-proxy on.**

### MR-D2 — frontend de-token (→ frontend-engineer, gated on D1 merge + oauth2-proxy live)
- `web-ui/src/lib/api.ts`: drop `getToken`/`clearToken` + `Authorization` header; add `credentials:'include'` to every fetch; on 401 → `window.location.href = '/oauth2/sign_in?rd=' + encodeURIComponent(location.pathname+location.search)`.
- Delete `web-ui/src/lib/token.ts` and `web-ui/src/routes/login.tsx`.
- `web-ui/src/App.tsx`: remove `/login` route + `RequireToken` wrapper; sign-out → link to `/oauth2/sign_out`; the `Shell` 401 effect → hard oauth2 redirect (not `nav('/login')`).
- `MetaBar` copy: `vpn · 飞连 only` → `飞连 SSO`.
- `web-ui` README auth section updated.
- **Must NOT deploy until oauth2-proxy is live**, else the SPA has zero auth.

## 11.6 oauth2-proxy route config (hand to ops) — FINAL

**Two route lists (both required):**

`skip_auth_routes` — open probes ONLY. Truly unauthenticated, no session loaded, no headers, no challenge. Reverse-proxied straight to upstream.

```
skip_auth_routes = [
  "GET=^/healthz$",
  "GET=^/readyz$",
  "GET=^/health$",
  "GET=^/api/manifest$",
  "GET=^/ping$",
]
```

Notes:
- `/healthz`, `/readyz`, `/ping` listed for ops probe compatibility even if the backend doesn't currently expose them (cheap; harmless if 404 from upstream). The backend currently exposes `/health` (per `packages/server/src/server.ts`) and `/api/manifest` (open by design).
- **No `/api/cli/` entry** — there is no CLI traffic on this host (CLI hits public `/core` instead). t5t's CLI skip pattern does NOT transfer here.
- **No `/admin/` entry** — admin endpoints must NEVER be reachable from a browser session; admin CLI uses the public host with Bearer.

`api_routes` — paths that must be authenticated; oauth2-proxy returns **HTTP 401 (not 302)** for unauthenticated, AND injects identity headers for authenticated:

```
api_routes = [
  "^/api/memory/",
  "^/api/skills/",
  "^/api/",
]
```

Notes:
- The catch-all `^/api/` at the end covers any future GET endpoints under `/api/` without a config push. Harmless because (a) the more-specific entries above match first for browser-relevant routes, (b) write/admin endpoints aren't reachable for web identity per §11.2 structural fork, (c) `/api/manifest` is matched by `skip_auth_routes` first and stays open.
- These are **NOT in `skip_auth_routes`**. Earlier draft put them there; that was based on a t5t-single-host premise that doesn't apply here (see §11.4).

**Everything else** (SPA shell `/`, `/assets/*`, deep routes like `/skills`, `/memory/*` page routes) → default oauth2-proxy flow → unauth redirects 302 to Feilian. That's correct for full-page loads.

**oauth2-proxy mandatory flags** (per verified t5t recipe — ops must not deviate):
- `provider=oidc`, OIDC client_id/secret/issuer via `EnvironmentFile`, cookie_secret 32B base64 via separate `EnvironmentFile`
- `pass_user_headers=true`, `set_xauthrequest=true`
- `pass_access_token=false`, `pass_authorization_header=false`, `set_authorization_header=false`
- **`prefer_email_to_user=false` (MANDATORY — true silently eats `X-Forwarded-Email`)**
- `skip_provider_button=true`, `cookie_secure=true`, `cookie_samesite=lax`
- `email_domains=["xvirobotics.com"]` AND single-email allowed list = `flood-sung@xvirobotics.com`
- `http_address="127.0.0.1:4180"`, `reverse_proxy=true` (no `https_address` / `tls_*` — Caddy SNI-routes the UI host to this on :443 already)

## 11.7 Sequencing & rollback

D1 (additive, default-off, mergeable anytime) → ops lands oauth2-proxy + sets `METABOT_CORE_UI_ALLOWED_EMAILS=flood-sung@xvirobotics.com` + `skip_auth_routes` → D2 (de-token SPA, only after proxy live) → QA smoke from 飞连 incl. **forged-`X-Forwarded-Email`-from-outside-proxy → 401/403 negative test**. Rollback: unset `METABOT_CORE_UI_ALLOWED_EMAILS` (web-identity off) reverts backend to Bearer-only; revert D2 to restore token-paste if proxy must come down.

## 11.8 Access scope

Single-email whitelist `flood-sung@xvirobotics.com` ONLY (most restrictive — brain-trust content is sensitive). Enforced at TWO layers: oauth2-proxy (primary) + backend `METABOT_CORE_UI_ALLOWED_EMAILS` (defense-in-depth). Widening later = add emails to both.
