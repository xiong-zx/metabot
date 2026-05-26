#!/usr/bin/env bash
#
# metabot bootstrap — internal-network one-line installer.
#
# Usage:
#   curl -fsSL https://metabot-core.xvirobotics.com/install/install.sh | bash
#   curl -fsSL ... | METABOT_HOME=/opt/metabot bash
#   curl -fsSL ... | bash -s -- --dir /opt/metabot
#
# What this does:
#   1. Resolve METABOT_HOME (--dir > env > $HOME/metabot).
#   2. If $METABOT_HOME/.git + install.sh exist → delegate to the existing
#      install.sh (which handles `git pull --ff-only`). This is the migration
#      path for users who originally cloned from GitHub/GitLab — zero behavior
#      change for them.
#   3. Otherwise (fresh box or tarball-mode upgrade):
#       - Download latest.tgz from $METABOT_CORE_URL/install/latest.tgz
#       - Extract into $METABOT_HOME (preserves .env / bots.json / logs /
#         data — they are not in the tarball)
#       - exec install.sh with METABOT_SKIP_GIT=1 so its Phase 2 skips the
#         clone/pull branch and proceeds straight to npm install +
#         configuration prompts + PM2 start.
#
# Refresh model: same as /cli/latest.tgz — always-latest, pinned by atomic
# publish. Re-run the one-liner to refresh; `metabot update` on tarball
# installs reroutes back here.
#
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

info()    { echo -e "${BLUE}[bootstrap]${NC} $*"; }
warn()    { echo -e "${YELLOW}[bootstrap]${NC} $*"; }
error()   { echo -e "${RED}[bootstrap]${NC} $*" >&2; }
success() { echo -e "${GREEN}[bootstrap]${NC} $*"; }

echo ""
echo -e "${CYAN}  MetaBot bootstrap (internal tarball install)${NC}"
echo ""

# ----- 1. parse flags (only --dir / -d; everything else is forwarded) -----
INSTALL_DIR_ARG=""
PASSTHRU_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -d|--dir)
      [[ $# -ge 2 ]] || { error "$1 requires a path argument"; exit 1; }
      INSTALL_DIR_ARG="$2"
      PASSTHRU_ARGS+=("$1" "$2")
      shift 2
      ;;
    --dir=*)
      INSTALL_DIR_ARG="${1#--dir=}"
      PASSTHRU_ARGS+=("$1")
      shift
      ;;
    *)
      PASSTHRU_ARGS+=("$1")
      shift
      ;;
  esac
done

# ----- 2. resolve METABOT_HOME -----
if [[ -n "$INSTALL_DIR_ARG" ]]; then
  METABOT_HOME="$INSTALL_DIR_ARG"
elif [[ -n "${METABOT_HOME:-}" ]]; then
  : # already set
else
  METABOT_HOME="$HOME/metabot"
fi
METABOT_HOME="${METABOT_HOME/#\~/$HOME}"
if [[ "$METABOT_HOME" != /* ]]; then
  error "METABOT_HOME must be an absolute path, got: $METABOT_HOME"
  exit 1
fi
export METABOT_HOME

# ----- 3. preflight: curl + tar are mandatory; node check is install.sh's job -----
for cmd in curl tar; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    error "$cmd is required but not on PATH."
    exit 1
  fi
done

# ----- 4. existing .git checkout → hand off to its install.sh (git pull path) -----
if [[ -d "$METABOT_HOME/.git" && -f "$METABOT_HOME/install.sh" ]]; then
  info "Existing git checkout at $METABOT_HOME"
  info "Delegating to its install.sh (git pull path) — tarball mode skipped."
  cd "$METABOT_HOME"
  if [[ ${#PASSTHRU_ARGS[@]} -gt 0 ]]; then
    exec bash "$METABOT_HOME/install.sh" "${PASSTHRU_ARGS[@]}"
  else
    exec bash "$METABOT_HOME/install.sh"
  fi
fi

# ----- 5. fresh / tarball-mode install: download + extract -----
CORE_URL="${METABOT_CORE_URL:-https://metabot-core.xvirobotics.com}"
TARBALL_URL="$CORE_URL/install/latest.tgz"
TMPDIR_BOOT="$(mktemp -d -t metabot-install.XXXXXX)"
trap 'rm -rf "$TMPDIR_BOOT"' EXIT
TARBALL_PATH="$TMPDIR_BOOT/metabot.tgz"

info "Downloading $TARBALL_URL"
if ! curl -fsSL "$TARBALL_URL" -o "$TARBALL_PATH"; then
  error "Download failed. Is metabot-core reachable via 飞连/VPN?"
  error "  URL: $TARBALL_URL"
  error "  Override host with: METABOT_CORE_URL=https://… curl … | bash"
  exit 1
fi

if [[ ! -s "$TARBALL_PATH" ]]; then
  error "Downloaded tarball is empty."
  exit 1
fi
if ! tar -tzf "$TARBALL_PATH" >/dev/null 2>&1; then
  error "Downloaded file is not a valid tarball:"
  head -c 200 "$TARBALL_PATH" >&2
  echo "" >&2
  exit 1
fi

mkdir -p "$METABOT_HOME"
info "Extracting into $METABOT_HOME"
# --keep-newer-files: preserves any locally-modified files newer than the
#   tarball (e.g. user-edited install.sh between bootstrap runs).
# .env / bots.json / logs/ / data/ are NOT in the tarball, so they survive
# trivially.
tar xzf "$TARBALL_PATH" -C "$METABOT_HOME" --keep-newer-files

if [[ ! -f "$METABOT_HOME/install.sh" ]]; then
  error "Extraction completed but install.sh is missing at $METABOT_HOME/install.sh"
  error "Tarball may be corrupt. Re-run the bootstrap; if it fails again, ping infra."
  exit 1
fi

# ----- 6. delegate to install.sh (Phase 2 sees METABOT_SKIP_GIT=1) -----
cd "$METABOT_HOME"
export METABOT_SKIP_GIT=1
success "Tarball staged at $METABOT_HOME — handing off to install.sh."
echo ""
if [[ ${#PASSTHRU_ARGS[@]} -gt 0 ]]; then
  exec bash "$METABOT_HOME/install.sh" "${PASSTHRU_ARGS[@]}"
else
  exec bash "$METABOT_HOME/install.sh"
fi
