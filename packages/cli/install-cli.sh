#!/usr/bin/env bash
# One-shot installer for the metabot CLI. Served at
# `<host>/cli/install.sh` from metabot-core (anonymous, intranet-only via
# 飞连 VPN). Intended UX:
#
#   curl -fsSL https://metabot-core.xvirobotics.com/cli/install.sh \
#     | METABOT_CORE_TOKEN=mt_xxx bash
#
# Installs:
#   - `metabot` on PATH (npm global or ~/.local fallback)
#   - $HOME/.metabot-core/token (chmod 600) if METABOT_CORE_TOKEN was set
#   - $HOME/.claude/skills/metabot/  (Claude Code skill for /metabot)
#
# Does NOT install the Feishu bridge / bots.json / PM2 / engines. That path is
# the full GitLab-based `install.sh` at the repo root.

set -euo pipefail

CORE_URL_DEFAULT="https://metabot-core.xvirobotics.com"
CORE_URL="${METABOT_CORE_URL:-$CORE_URL_DEFAULT}"
TARBALL_URL="$CORE_URL/cli/latest.tgz"
TARBALL_TMP="$(mktemp -t metabot-cli.XXXXXX.tgz)"
trap 'rm -f "$TARBALL_TMP"' EXIT

c_red()   { printf '\033[31m%s\033[0m' "$*"; }
c_green() { printf '\033[32m%s\033[0m' "$*"; }
c_dim()   { printf '\033[2m%s\033[0m' "$*"; }
info()    { printf '%s %s\n' "$(c_dim '==>')" "$*"; }
warn()    { printf '%s %s\n' "$(c_red 'warn:')" "$*" >&2; }
fail()    { printf '%s %s\n' "$(c_red 'error:')" "$*" >&2; exit 1; }

# --- Step 1: node 20+ check -------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  fail "node not found. Install node 20+ (e.g. via nvm: 'nvm install 20') and retry."
fi
NODE_MAJOR="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  fail "node $NODE_MAJOR detected; metabot CLI requires node >= 20. Try 'nvm install 20'."
fi
if ! command -v npm >/dev/null 2>&1; then
  fail "npm not found alongside node. Reinstall node with npm bundled."
fi

# --- Step 2: download tarball ----------------------------------------------
info "Downloading $TARBALL_URL"
if ! curl -fsSL "$TARBALL_URL" -o "$TARBALL_TMP"; then
  fail "failed to download tarball from $TARBALL_URL — VPN connected? Server up?"
fi
if [[ ! -s "$TARBALL_TMP" ]]; then
  fail "downloaded tarball is empty"
fi

# --- Step 3: npm install -g (with ~/.local fallback on EACCES) -------------
INSTALL_PREFIX=""
install_global() {
  npm install -g --no-audit --no-fund "$TARBALL_TMP" 2>&1
}
install_local() {
  mkdir -p "$HOME/.local"
  npm install --prefix "$HOME/.local" -g --no-audit --no-fund "$TARBALL_TMP" 2>&1
}

info "Installing metabot-cli with npm..."
if NPM_OUT="$(install_global)"; then
  info "$(c_green 'installed') to npm global prefix ($(npm prefix -g 2>/dev/null || echo '?'))"
else
  if echo "$NPM_OUT" | grep -qE 'EACCES|EPERM|permission denied'; then
    warn "global npm prefix not writable — falling back to \$HOME/.local"
    if NPM_OUT="$(install_local)"; then
      INSTALL_PREFIX="$HOME/.local"
      info "$(c_green 'installed') to $INSTALL_PREFIX"
    else
      echo "$NPM_OUT" >&2
      fail "local install also failed; see npm output above"
    fi
  else
    echo "$NPM_OUT" >&2
    fail "npm install failed; see output above"
  fi
fi

# --- Step 4: locate the installed package + skill --------------------------
# Resolve the package root via the same npm prefix we just installed to.
if [[ -n "$INSTALL_PREFIX" ]]; then
  PKG_ROOT="$INSTALL_PREFIX/lib/node_modules/metabot-cli"
  BIN_DIR="$INSTALL_PREFIX/bin"
else
  NPM_GLOBAL_ROOT="$(npm root -g 2>/dev/null || true)"
  PKG_ROOT="$NPM_GLOBAL_ROOT/metabot-cli"
  BIN_DIR="$(npm prefix -g 2>/dev/null || true)/bin"
fi

if [[ ! -d "$PKG_ROOT" ]]; then
  warn "could not locate installed metabot-cli at $PKG_ROOT — skill copy may be skipped"
fi

# --- Step 5: write token + url (if env vars set) ---------------------------
CONFIG_DIR="$HOME/.metabot-core"
mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"

if [[ -n "${METABOT_CORE_TOKEN:-}" ]]; then
  printf '%s\n' "$METABOT_CORE_TOKEN" > "$CONFIG_DIR/token"
  chmod 600 "$CONFIG_DIR/token"
  info "wrote token → $CONFIG_DIR/token"
else
  info "no METABOT_CORE_TOKEN set; visit $CORE_URL/cli to mint one"
fi

if [[ -n "${METABOT_CORE_URL:-}" && "$METABOT_CORE_URL" != "$CORE_URL_DEFAULT" ]]; then
  printf '%s\n' "$METABOT_CORE_URL" > "$CONFIG_DIR/url"
  info "wrote url → $CONFIG_DIR/url ($METABOT_CORE_URL)"
fi

# --- Step 6: install /metabot skill ----------------------------------------
SKILL_SRC="$PKG_ROOT/skills/metabot"
SKILL_DST="$HOME/.claude/skills/metabot"
if [[ -d "$SKILL_SRC" ]]; then
  mkdir -p "$HOME/.claude/skills"
  if [[ -d "$SKILL_DST" ]]; then
    # Back up only if checksums differ; otherwise just overwrite silently.
    SRC_HASH="$(find "$SKILL_SRC" -type f -name '*.md' -print0 | sort -z | xargs -0 cat | sha256sum | cut -d' ' -f1)"
    DST_HASH="$(find "$SKILL_DST" -type f -name '*.md' -print0 | sort -z | xargs -0 cat 2>/dev/null | sha256sum | cut -d' ' -f1)"
    if [[ "$SRC_HASH" != "$DST_HASH" ]]; then
      BACKUP="$SKILL_DST.bak.$(date +%s)"
      mv "$SKILL_DST" "$BACKUP"
      info "backed up existing skill → $BACKUP"
    fi
  fi
  mkdir -p "$SKILL_DST"
  cp -R "$SKILL_SRC/." "$SKILL_DST/"
  info "installed /metabot skill → $SKILL_DST"
else
  warn "bundled skill not found at $SKILL_SRC — skipped"
fi

# --- Step 7: self-check ----------------------------------------------------
# Try to invoke `metabot health`. PATH may not yet include the bin dir if we
# fell back to ~/.local — handle both.
METABOT_BIN=""
if command -v metabot >/dev/null 2>&1; then
  METABOT_BIN="$(command -v metabot)"
elif [[ -x "$BIN_DIR/metabot" ]]; then
  METABOT_BIN="$BIN_DIR/metabot"
fi

if [[ -z "$METABOT_BIN" ]]; then
  warn "metabot binary not on PATH yet. Bin dir: $BIN_DIR"
else
  info "running self-check: $METABOT_BIN health"
  if HEALTH_OUT="$("$METABOT_BIN" health 2>&1)"; then
    printf '%s\n' "$HEALTH_OUT"
  else
    warn "health check failed:"
    printf '%s\n' "$HEALTH_OUT" >&2
    warn "common causes: token wrong/missing, VPN disconnected, METABOT_CORE_URL typo"
  fi
fi

# --- Step 8: success banner ------------------------------------------------
echo
echo "$(c_green '✓ metabot CLI installed.')"
if [[ -n "$INSTALL_PREFIX" ]]; then
  echo
  echo "Add this to your shell rc if not already present:"
  echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
fi
echo
echo "Next steps:"
echo "  metabot --help            # subcommands"
echo "  metabot memory list       # browse central memory"
echo "  metabot agents            # list peer bots"
echo "  metabot t5t board         # today's t5t"
echo
echo "Token can be rotated any time at: $CORE_URL/cli"
