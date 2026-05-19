# @xvirobotics/metabot-core-web-ui

Internal browser console for the metabot-core archive — read-only viewer for
meta-memory documents and the skill hub.

> Read-only MVP (Phase 1 of the Web UI). Creating / editing / deleting
> documents stays on the `mm` CLI. See `docs/internal/web-ui-arch.md`.

## Stack

- React 18 + React Router 6, built with Vite.
- `marked` + `DOMPurify` for Markdown rendering (sanitized before injection).
- Stored HTML documents render inside a sandboxed `<iframe srcdoc>` —
  **no `allow-scripts`**; stored HTML is treated as data, not code.

## Dev

```bash
# from repo root, deps are workspace-hoisted:
npm install

# run the metabot-core server somewhere reachable on :9200, then:
cd packages/web-ui
npm run dev          # Vite dev server on http://localhost:5173
```

The dev server proxies `/api`, `/admin`, and `/health` to
`http://127.0.0.1:9200`, so a local metabot-core server works without CORS
fuss. In production the SPA has no login screen of its own — auth lives in
oauth2-proxy in front of metabot-core; see the Runtime expectations section.

## Build

```bash
npm run build        # tsc && vite build
```

Output goes to **`../server/static/`** (not a local `dist/`). That directory
is gitignored and is what `packages/server` serves when a request arrives on
the `METABOT_CORE_UI_HOST` hostname. `deploy/install.sh` rsyncs it to
`/opt/metabot-core/static/` when present.

## Runtime expectations

- The SPA only works when reached via the host configured in
  `METABOT_CORE_UI_HOST` on the server. Other hosts (e.g. raw IP probes
  inside the deploy box) return 404 for `/` and `/assets/*` by design —
  the API stays reachable everywhere, the UI does not. Post-P4-MR6 the
  dedicated front-door domain
  `METABOT_CORE_UI_HOST=metabot-core.xvirobotics.com` is also the CLI's
  default URL. The shared multi-tenant `metabot.xvirobotics.com` is a
  different host and is not used as the SPA front door; legacy CLIs
  pinned to its `/core` sub-handle keep working. The predecessor
  `metabot-core-ui.xvirobotics.com` retires 24h after cutover.
- **Auth: 飞连 SSO via oauth2-proxy (Model B).** The SPA carries no token
  itself. `fetch` calls go out with `credentials: 'include'` so the
  oauth2-proxy session cookie rides along; metabot-core reads the
  `X-Forwarded-Email` header oauth2-proxy injects and mints a synthetic
  per-request web credential. If any `/api/*` reply is 401, the SPA does
  a hard redirect to `/oauth2/sign_in?rd=<current-url>` — there is no
  in-app login screen. "Sign out" is a link to `/oauth2/sign_out`.

## Routes

| Path | View |
|---|---|
| `/` | folder tree + last 50 documents |
| `/memory/*path` | folder listing or document viewer (deep-linkable) |
| `/skills` | published skill registry |
| `/skills/:name` | rendered SKILL.md + metadata sidebar |
| `/t5t` | t5t board — projects, recent entries, anomaly zone |
| `/t5t/:slug` | project detail — goal, evaluators, bottleneck, WIP, timeline, feedback |
| `/search?q=…` | unified memory + skill full-text search |
