#!/usr/bin/env bash
#
# metabot-core — server installer for the internal ECS host (172.31.32.2).
#
# Idempotent: safe to re-run. Steps:
#   - mkdir -p /vepfs/users/floodsung/metabot-core-data (data root)
#   - mkdir -p /opt/metabot-core (install root)
#   - rsync the built package (dist/, node_modules/, package.json, bin/) to /opt/metabot-core
#   - chown to floodsung
#   - install /etc/metabot-core/env (idempotent: never overwrites)
#   - install systemd unit, daemon-reload, enable + (re)start
#
# What this script DOES NOT do:
#   - Touch /etc/caddy/Caddyfile (the orchestrator APPENDS deploy/caddy/snippet.caddyfile
#     as a new standalone `metabot-core.xvirobotics.com { ... }` host block and runs
#     `systemctl reload caddy`. The shared multi-tenant `metabot.xvirobotics.com`
#     block is left untouched).
#   - Issue or copy TLS certs (the orchestrator runs the certbot DNS-01
#     command in the runbook below; cert is copied into /etc/caddy/tls/<host>/).
#   - Install the new oauth2-proxy-metabot-core.{service,cfg} units or the
#     metabot-core-cert-renew.{timer,service} pair — those are runbook steps.
#   - Install Node or any system package — assumes Node 20+ is already on PATH.
#
# Usage (as root, on the deploy host):
#     sudo bash deploy/install.sh
#
set -euo pipefail

if [[ "$EUID" -ne 0 ]]; then
  echo "error: must run as root (try sudo)" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

USER_NAME="floodsung"
DATA_DIR="/vepfs/users/floodsung/metabot-core-data"
INSTALL_DIR="/opt/metabot-core"
ETC_DIR="/etc/metabot-core"
SERVICE_NAME="metabot-core"

if ! id -u "$USER_NAME" >/dev/null 2>&1; then
  echo "error: user '$USER_NAME' does not exist on this host" >&2
  exit 2
fi

if ! command -v node >/dev/null 2>&1; then
  echo "error: node not on PATH; install Node 20+ before running this script" >&2
  exit 2
fi

if [[ ! -d "$PKG_DIR/dist" ]]; then
  echo "error: $PKG_DIR/dist not found — run 'npm run build' in $PKG_DIR first" >&2
  exit 2
fi

echo "==> Ensuring data dir at $DATA_DIR"
mkdir -p "$DATA_DIR"
chown "$USER_NAME":"$USER_NAME" "$DATA_DIR"
chmod 750 "$DATA_DIR"

echo "==> Ensuring install dir at $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"

echo "==> Syncing package to $INSTALL_DIR"
# Sync built artifacts + manifest. Deps install fresh inside $INSTALL_DIR
# (next step) — we can't rsync the workspace-root node_modules because npm
# workspaces hoists shared deps there, and rsyncing $PKG_DIR/node_modules
# alone only catches the few packages that didn't hoist (e.g. better-sqlite3).
rsync -a --delete \
  --exclude='.git' \
  --exclude='tests' \
  --exclude='*.tsbuildinfo' \
  --exclude='coverage' \
  "$PKG_DIR/dist/" "$INSTALL_DIR/dist/"
rsync -a "$PKG_DIR/package.json" "$INSTALL_DIR/package.json"
rsync -a "$PKG_DIR/bin/" "$INSTALL_DIR/bin/"

# Web UI static assets (built by packages/web-ui via `vite build` into
# $PKG_DIR/static). Optional: only synced when present, so a server-only
# build still installs cleanly. The server resolves `static/` relative to
# its dist root (sibling of dist/), matching this layout.
if [[ -d "$PKG_DIR/static" ]]; then
  echo "==> Syncing web UI static assets to $INSTALL_DIR/static"
  rsync -a --delete "$PKG_DIR/static/" "$INSTALL_DIR/static/"
fi

chown -R "$USER_NAME":"$USER_NAME" "$INSTALL_DIR"

echo "==> Installing production deps in $INSTALL_DIR (as $USER_NAME)"
# Run as $USER_NAME so installed binaries / cache ownership stay consistent.
# Use `npm install --omit=dev` (no lockfile inside $INSTALL_DIR yet).
sudo -u "$USER_NAME" bash -c "cd '$INSTALL_DIR' && npm install --omit=dev --no-audit --no-fund"

echo "==> Writing $ETC_DIR/env (idempotent — keeps existing values)"
mkdir -p "$ETC_DIR"
if [[ ! -f "$ETC_DIR/env" ]]; then
  cat > "$ETC_DIR/env" <<EOF
METABOT_CORE_HOST=127.0.0.1
METABOT_CORE_PORT=9200
METABOT_CORE_DATA_DIR=$DATA_DIR
METABOT_CORE_AUDIT_DIR=$DATA_DIR/audit
# Dedicated front-door domain (P4-MR6, 2026-05-19 — domain pivot):
# SPA + API + admin all live on metabot-core.xvirobotics.com. The shared
# multi-tenant metabot.xvirobotics.com is NOT used for the front door (its
# /core sub-handle remains for legacy CLIs).
METABOT_CORE_UI_HOST=metabot-core.xvirobotics.com
LOG_FORMAT=json
EOF
  chmod 640 "$ETC_DIR/env"
  chown root:"$USER_NAME" "$ETC_DIR/env"
else
  echo "    (existing $ETC_DIR/env left untouched)"
fi

echo "==> Installing systemd unit"
UNIT_SRC="$PKG_DIR/deploy/systemd/metabot-core.service"
UNIT_DST="/etc/systemd/system/$SERVICE_NAME.service"
# Patch ExecStart to point at the installed dist/index.js so the unit works
# regardless of where the package was built from.
NODE_BIN="$(command -v node)"
sed \
  -e "s|^ExecStart=.*|ExecStart=$NODE_BIN $INSTALL_DIR/dist/index.js|" \
  -e "s|^WorkingDirectory=.*|WorkingDirectory=$DATA_DIR|" \
  -e "s|^User=.*|User=$USER_NAME|" \
  -e "s|^ReadWritePaths=.*|ReadWritePaths=$DATA_DIR|" \
  "$UNIT_SRC" > "$UNIT_DST"
# Inject EnvironmentFile only if missing (sed -i appended once)
if ! grep -q "EnvironmentFile=-$ETC_DIR/env" "$UNIT_DST"; then
  sed -i "s|^EnvironmentFile=.*|EnvironmentFile=-$ETC_DIR/env|" "$UNIT_DST"
fi

systemctl daemon-reload
systemctl enable "$SERVICE_NAME.service"

echo "==> Starting $SERVICE_NAME"
systemctl restart "$SERVICE_NAME.service"

echo "==> Done"
echo "Health: curl -fsS http://127.0.0.1:9200/health"
echo "Logs:   journalctl -u $SERVICE_NAME -f"
echo "Admin bootstrap token (first run only): cat $DATA_DIR/admin-bootstrap-token.txt"
echo ""
echo "Next steps (orchestrator does these — not this script):"
echo "  1. DNS A record (orchestrator via Volcengine SDK, zone 215293):"
echo "       metabot-core.xvirobotics.com A 172.31.32.2 TTL=600"
echo "     Feilian redirect_uri append (feilian-admin):"
echo "       append https://metabot-core.xvirobotics.com/oauth2/callback"
echo "       to OIDC app 5653's redirect_uris (KEEP existing entries)."
echo ""
echo "  2. Issue cert via certbot DNS-01 (shared host-resident hooks; "
echo "     use /usr/local/bin/certbot — the /usr/bin one has broken urllib3):"
echo "       sudo /usr/local/bin/certbot certonly --manual --preferred-challenges dns-01 \\"
echo "         --manual-auth-hook /etc/caddy/certbot-hooks/dns01-auth.sh \\"
echo "         --manual-cleanup-hook /etc/caddy/certbot-hooks/dns01-cleanup.sh \\"
echo "         --cert-name metabot-core.xvirobotics.com \\"
echo "         -d metabot-core.xvirobotics.com \\"
echo "         --key-type ecdsa --agree-tos --non-interactive --no-eff-email"
echo "       sudo mkdir -p /etc/caddy/tls/metabot-core.xvirobotics.com"
echo "       sudo cp /etc/letsencrypt/live/metabot-core.xvirobotics.com/{fullchain,privkey}.pem \\"
echo "          /etc/caddy/tls/metabot-core.xvirobotics.com/"
echo "       sudo chown -R caddy:caddy /etc/caddy/tls/metabot-core.xvirobotics.com"
echo ""
echo "  3. APPEND deploy/caddy/snippet.caddyfile as a NEW standalone"
echo "     metabot-core.xvirobotics.com { ... } block in /etc/caddy/Caddyfile."
echo "     DO NOT touch the existing multi-tenant metabot.xvirobotics.com block."
echo ""
echo "  4. Install deploy/oauth2-proxy/oauth2-proxy-metabot-core.cfg as"
echo "     /etc/oauth2-proxy-metabot-core/oauth2-proxy.cfg (the systemd"
echo "     unit's actual --config= path)."
echo "     OIDC client_id / client_secret live in /etc/feilian/metabot_core_oidc.env"
echo "     (Feilian app 5653). cookie_secret is generated fresh in the next step"
echo "     into its own EnvironmentFile so it can be rotated independently."
echo ""
echo "  5. Generate a FRESH, independent cookie_secret for the new unit"
echo "     (one-time; operator runs this on the deploy host):"
echo "       sudo mkdir -p /etc/oauth2-proxy-metabot-core"
echo "       printf 'OAUTH2_PROXY_COOKIE_SECRET=%s\\n' \\"
echo "         \"\$(openssl rand -base64 24)\" \\"
echo "         | sudo tee /etc/oauth2-proxy-metabot-core/cookie.env > /dev/null"
echo "       sudo chmod 640 /etc/oauth2-proxy-metabot-core/cookie.env"
echo "       sudo chown root:oauth2-proxy /etc/oauth2-proxy-metabot-core/cookie.env"
echo "     IMPORTANT: use \`openssl rand -base64 24\` (= base64 of 24 raw bytes ="
echo "     AES-192) when cookie_domains is set in the cfg — oauth2-proxy v7"
echo "     validates the cookie_secret as an AES key in that code path, and"
echo "     only 16 / 24 / 32 raw-byte lengths are accepted. The systemd unit"
echo "     loads this as a second EnvironmentFile alongside"
echo "     /etc/feilian/metabot_core_oidc.env."
echo ""
echo "  6. Install the new oauth2-proxy systemd unit + cert-renew timer:"
echo "       sudo cp deploy/systemd/oauth2-proxy-metabot-core.service /etc/systemd/system/"
echo "       sudo cp deploy/systemd/metabot-core-cert-renew.{timer,service} /etc/systemd/system/"
echo "       sudo systemctl daemon-reload"
echo "       sudo systemctl enable --now oauth2-proxy-metabot-core.service"
echo "       sudo systemctl enable --now metabot-core-cert-renew.timer"
echo ""
echo "  7. Validate Caddy, reload, restart backend:"
echo "       sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile"
echo "       sudo systemctl reload caddy"
echo "       sudo systemctl restart metabot-core"
echo ""
echo "  8. Smoke (3 must-pass):"
echo "       curl -sI https://metabot-core.xvirobotics.com/                                                    # 302 → Feilian"
echo "       TOKEN=\$(cat ~/.metabot-core/token); curl -sI -H \"Authorization: Bearer \$TOKEN\" \\"
echo "          https://metabot-core.xvirobotics.com/api/agents                                                # 200"
echo "       curl -sI https://metabot-core.xvirobotics.com/api/manifest                                        # 200"
echo ""
echo "  Web UI host gating: $ETC_DIR/env now ships with"
echo "    METABOT_CORE_UI_HOST=metabot-core.xvirobotics.com"
echo "  (P4-MR6 domain pivot — dedicated front-door domain; the shared"
echo "  multi-tenant metabot.xvirobotics.com is NOT touched). Existing"
echo "  /etc/metabot-core/env files are NOT rewritten by this script —"
echo "  operators upgrading must edit this line by hand and restart."
