# Phase 4 portal cutover — `metabot-core.xvirobotics.com` is the new front door

**Date:** 2026-05-19
**Audience:** the whole team
**Action required:** see "What you need to do" below.

> **URL heads-up:** the new front door is **`metabot-core.xvirobotics.com`**
> (dash between `metabot` and `core`). The shared multi-tenant
> `metabot.xvirobotics.com` is a **different host** owned by several teams
> and is NOT affected by this cutover. CLIs that were previously pointed at
> `https://metabot.xvirobotics.com/core` keep working — that legacy
> sub-handle is untouched. The `metabot-core-ui.xvirobotics.com` predecessor
> stays live for a 24h soak, then retires.

## 中文版（先看这段）

**新前门 `https://metabot-core.xvirobotics.com`** — 飞连登陆，进去后能看到四个面板：
**t5t**（每个 project 的状态板）、**metamemory**（按 user 分组的知识库浏览）、
**skill-hub**（已发布的 skill 列表）、**agents**（在线 agent 只读列表，交互仍在
飞书）。最重要的是：**CLI Access (`/cli`) 页面一键生成自己的 access token + `.env`
配置**，复制粘贴到 `~/.metabot-core/.env` 就能直接用 `metabot xxx`，不用再找
flood 单独发 token。

**旧的 `mb` / `mm` / `mh` CLI 已经全部下线**，统一为 `metabot xxx`。旧的 `t5t`
Python CLI（写死指向 `t5t.xvirobotics.com` 的那个）同步退役 —— 它会失效因为
hardcoded host 不再服务。老的 `metabot-core-ui.xvirobotics.com` 域名将在切换 24
小时后下线（保留这一晚做 soak 测试）。**多租户的 `metabot.xvirobotics.com`（不是
新的 `metabot-core.xvirobotics.com`，注意中间那条横杠）属于另外几个团队的共享 Caddy
host，本次切换完全不动它；老的 `https://metabot.xvirobotics.com/core` 子路径继续可用，
不会破坏已经配在旧 URL 上的 CLI。**

### 你需要做什么

1. 打开 `https://metabot-core.xvirobotics.com`，飞连登陆。
2. 进 **CLI Access** 页面，**Generate**，复制 `.env` 块。
3. 粘贴到 `~/.metabot-core/.env`（或者直接 export 到当前 shell）。
4. 跑一下 `metabot agents whoami` 验证。
5. 任何脚本里如果还在调 `mb` / `mm` / `mh` / `t5t`（Python），换成
   `metabot xxx` 形式（对照表见下面 EN 版 / `docs/internal/onboarding.md`）。

完整 onboarding 文档：[`docs/internal/onboarding.md`](../onboarding.md)。

## English

**One front door — `https://metabot-core.xvirobotics.com`.** Log in once via
飞连 OIDC; you'll land on a four-panel portal: **t5t** (per-project status
board), **metamemory** (memory archive, grouped by user), **skill-hub**
(published skills), and **agents** (read-only agent registry — actual
cross-agent talk stays in Feishu). Most importantly, the **CLI Access** page
is now a self-service onboarding surface: click **Generate**, copy the
rendered `.env` block, and you have a working `metabot` CLI in under a
minute. No more pinging the admin for a manually-minted token.

**The legacy CLIs `mb`, `mm`, `mh` are gone.** All four subcommand families
are reached via the single `metabot` binary now (P4-MR4, merged earlier this
week). Likewise the old Python `t5t` CLI (hardcoded against
`t5t.xvirobotics.com`) is retired — its host stops serving its API as part
of this cutover, and traffic to `t5t.xvirobotics.com/*` 301-redirects to
`https://metabot-core.xvirobotics.com/t5t{path}` for ~1-2 weeks of grace.

### URL status table

| URL | Status |
|---|---|
| `https://metabot-core.xvirobotics.com` | **NEW canonical front door** (browser + CLI default). |
| `https://metabot.xvirobotics.com` | **Untouched.** Shared multi-tenant Caddy host owned by other teams (`/slam-video`, `/droidw-viz`, `/nav-viz`, `/pipeline`, `/seedance`, `/bp`, `/dreamfactory`, …). Don't expect the metabot-core SPA at the bare root here. |
| `https://metabot.xvirobotics.com/core` | **Preserved as-is, indefinitely.** Legacy CLI URL — keeps serving metabot-core via the original sub-handle. No compat alias; the original Caddy block is just left alone. |
| `https://metabot-core-ui.xvirobotics.com` | **Retiring** 24h after the cutover (soak window). |
| `https://t5t.xvirobotics.com` | **Redirects** to `https://metabot-core.xvirobotics.com/t5t{path}` during a ~1-2 week transition, then DNS retires. |

### Migration cheat-sheet

| Old | New |
|---|---|
| `mm <cmd>` | `metabot memory <cmd>` |
| `mh <cmd>` | `metabot skills <cmd>` |
| `mb talk …` | `metabot agents talk <peer>[/<bot>] <chatId> "<msg>"` |
| `t5t push <slug> <date> "<item>"` (Python) | `metabot t5t push <slug> <date> "<item>"` |
| `https://metabot.xvirobotics.com/core` (CLI URL) | `https://metabot-core.xvirobotics.com` (still works as before; the new value is the recommended default) |
| `https://metabot-core-ui.xvirobotics.com` (browser) | `https://metabot-core.xvirobotics.com` |
| `~/.t5t/credentials` | self-service token via the portal (see onboarding) |

Full reference: [`docs/internal/onboarding.md`](../onboarding.md).

### What you need to do

If you have a workstation or bot that uses any metabot-core CLI:

1. Open `https://metabot-core.xvirobotics.com`, log in via 飞连.
2. Hit **CLI Access** → **Generate**, copy the `.env` block.
3. Paste into `~/.metabot-core/.env` (or export in your shell).
4. Verify: `metabot agents whoami` echoes your identity.
5. Grep your dotfiles / scripts for `mb `, `mm `, `mh `, `t5t ` and the
   `t5t.xvirobotics.com` / `metabot-core-ui` hostnames — swap each for the
   new equivalent above. (Refs to `https://metabot.xvirobotics.com/core`
   are not urgent; they keep working — change at your convenience.)

### For on-call / orchestrator

The live cutover follows the runbook in the **P4-MR7 MR description**
(domain pivot to `metabot-core.xvirobotics.com` + cert-pattern alignment +
isolated :4182 oauth2-proxy unit). Phase A brings up the new front door
without touching any existing block; Phase B (t5t redirect) follows once
Phase A smoke is green.

Order on the day:
1. Add Volcengine DNS A record `metabot-core.xvirobotics.com` → `172.31.32.2`
   (TTL 60s for the first 24h).
2. Append the new Feilian OIDC redirect URI to app **5653** (same app as
   the legacy `metabot-core-ui` unit — semantic owner is unchanged):
   `https://metabot-core.xvirobotics.com/oauth2/callback` (keep existing
   entries — required for rollback).
3. Issue cert via certbot DNS-01 (shared host-resident hooks; **use
   `/usr/local/bin/certbot`** — the `/usr/bin` copy has broken urllib3):
   ```
   sudo /usr/local/bin/certbot certonly --manual --preferred-challenges dns-01 \
     --manual-auth-hook /etc/caddy/certbot-hooks/dns01-auth.sh \
     --manual-cleanup-hook /etc/caddy/certbot-hooks/dns01-cleanup.sh \
     --cert-name metabot-core.xvirobotics.com -d metabot-core.xvirobotics.com \
     --key-type ecdsa --agree-tos --non-interactive --no-eff-email
   sudo mkdir -p /etc/caddy/tls/metabot-core.xvirobotics.com
   sudo cp /etc/letsencrypt/live/metabot-core.xvirobotics.com/{fullchain,privkey}.pem \
      /etc/caddy/tls/metabot-core.xvirobotics.com/
   sudo chown -R caddy:caddy /etc/caddy/tls/metabot-core.xvirobotics.com
   ```
   (Caddy on this host lacks the DNS-01 ACME module, and the domain
   resolves to RFC1918 `172.31.32.2`, so auto-cert is impossible — explicit
   `tls` paths are mandatory. Same pattern as `mail.xvirobotics.com` +
   `metabot-core-ui.xvirobotics.com`.)
4. Append the new `metabot-core.xvirobotics.com { ... }` host block from
   `packages/server/deploy/caddy/snippet.caddyfile` to `/etc/caddy/Caddyfile`.
   **Don't touch any other block** — neither the multi-tenant
   `metabot.xvirobotics.com` nor the legacy `metabot-core-ui.xvirobotics.com`
   (the latter keeps its own `:4180` oauth2-proxy unit during the soak).
5. Install the NEW oauth2-proxy cfg + isolated systemd unit + cert-renew
   timer:
   ```
   sudo install -o root -g root -m 0644 \
     packages/server/deploy/oauth2-proxy/oauth2-proxy-metabot-core.cfg \
     /etc/oauth2-proxy-metabot-core/oauth2-proxy.cfg
   sudo cp packages/server/deploy/systemd/oauth2-proxy-metabot-core.service \
           /etc/systemd/system/
   sudo cp packages/server/deploy/systemd/metabot-core-cert-renew.{timer,service} \
           /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now oauth2-proxy-metabot-core.service
   sudo systemctl enable --now metabot-core-cert-renew.timer
   ```
   (The new unit binds `:4182` — distinct from the legacy `:4180` unit.
   It reads `/etc/feilian/metabot_core_oidc.env`, the same secrets file
   the legacy unit uses since Feilian app 5653 is the same.)
6. `sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`
   → `sudo systemctl reload caddy` → `sudo systemctl restart metabot-core`.
7. Smoke:
   - `curl -sI https://metabot-core.xvirobotics.com/` → 302 to Feilian
   - `TOKEN=$(cat ~/.metabot-core/token); curl -sI -H "Authorization: Bearer $TOKEN" https://metabot-core.xvirobotics.com/api/agents` → 200
   - `curl -sI https://metabot-core.xvirobotics.com/api/manifest` → 200
8. Phase B (t5t redirect): only after Phase A is green. Issue
   `t5t.xvirobotics.com` cert the same way (cert-name `t5t.xvirobotics.com`,
   install `t5t-cert-renew.{timer,service}`), append the `t5t-redirect.caddyfile`
   block, lower DNS TTL ≥24h ahead, flip DNS to `172.31.32.2`, stop
   `t5t-portal` on `t5t-johor`, smoke `curl -sI https://t5t.xvirobotics.com/`
   → 301.
9. 24h soak: leave `metabot-core-ui.xvirobotics.com` (with its :4180
   `oauth2-proxy-mbcore.service`) running in parallel. After 24h with green
   metrics, retire its DNS record + disable the legacy unit.

Rollback if any smoke fails: `sudo systemctl disable --now
oauth2-proxy-metabot-core.service metabot-core-cert-renew.timer`, then
remove the new `metabot-core.xvirobotics.com` block from
`/etc/caddy/Caddyfile`, `systemctl reload caddy`. Zero impact on other
services — Phase A is pure-additive, no shared file or port is touched.

### Trouble?

Common issues + fixes in `docs/internal/onboarding.md#trouble`. For
anything else, ping `#metabot-core` in Feishu or `@flood-sung`.
