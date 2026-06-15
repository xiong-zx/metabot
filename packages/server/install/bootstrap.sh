#!/usr/bin/env bash
#
# metabot bootstrap — internal-network one-line installer.
#
# Usage:
#   curl -fsSL http://localhost:9200/install/install.sh | bash
#   curl -fsSL ... | METABOT_HOME=/opt/metabot bash
#   curl -fsSL ... | bash -s -- --dir /opt/metabot
#
# What this does:
#   1. Resolve METABOT_HOME (--dir > env > $HOME/metabot).
#   2. Download latest.tgz from $METABOT_CORE_URL/install/latest.tgz.
#   3. Extract into $METABOT_HOME, overwriting code files (`bin/`, `src/`,
#      `packages/`, `install.sh`, etc.). User state — `.env`, `bots.json`,
#      `logs/`, `data/` — is NOT in the tarball and survives trivially.
#      Any pre-existing `.git/` is also preserved (tarball excludes it), so
#      developers who hand-clone can still `git pull` later if they want,
#      but the bootstrap itself never touches a remote.
#   4. If the internal tarball includes `.metabot-package/default.env`, copy it
#      to `~/.metabot/default.env` with chmod 600 and remove the extracted copy.
#   5. exec install.sh with METABOT_SKIP_GIT=1 so its Phase 2 skips the
#      clone/pull branch entirely and proceeds straight to npm install +
#      configuration prompts + PM2 start.
#
# Why no .git delegation: GitHub `xvirobotics/metabot` is a selectively-
# cherry-picked OSS mirror that lags the GitLab monorepo, and most internal
# users lack GitLab SSH credentials. Always pulling tarball makes the refresh
# story uniform across fresh installs, GitHub clones, and GitLab clones —
# nobody silently runs stale code, nobody needs SSH keys.
#
# Refresh model: same as /cli/latest.tgz — always-latest, pinned by atomic
# publish. Re-run the one-liner to refresh; regular `metabot update` reroutes
# back here even if the target directory still has a preserved `.git/`.
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

# ----- 4. heads-up if we're overlaying onto an existing git checkout -----
# We do NOT delegate to its install.sh — that would `git pull` from a stale
# GitHub mirror (and even on a GitLab clone, we want a uniform tarball
# refresh story regardless of remote). `.git/` is excluded from the tarball
# so it's left intact; `git pull` still works manually for anyone who wants it.
if [[ -d "$METABOT_HOME/.git" ]]; then
  info "Existing .git/ at $METABOT_HOME left intact — tarball will overlay code only."
fi

# ----- 5. download + extract tarball (always) -----
CORE_URL="${METABOT_CORE_URL:-http://localhost:9200}"
TARBALL_URL="$CORE_URL/install/latest.tgz"
TMPDIR_BOOT="$(mktemp -d -t metabot-install.XXXXXX)"
trap 'rm -rf "$TMPDIR_BOOT"' EXIT
TARBALL_PATH="$TMPDIR_BOOT/metabot.tgz"

info "Downloading $TARBALL_URL"
if ! curl -fsSL "$TARBALL_URL" -o "$TARBALL_PATH"; then
  error "Download failed. Is metabot-core reachable at this URL?"
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
# Plain `tar xzf` overwrites tarball-tracked files in-place. We don't use
# --keep-newer-files because the pack script stamps every entry with a fixed
# `--mtime='UTC 2026-01-01'` for deterministic output — local files modified
# any time after that (i.e. essentially all of them on a real machine) would
# be silently kept, defeating the purpose of an overlay refresh.
#
# Files NOT in the tarball survive trivially because tar never deletes:
#   - .env / bots.json / logs/ / data/  (user state, never packed)
#   - .git/  (excluded so manual `git pull` still possible if desired)
#   - node_modules/  (excluded; Phase 3 npm install reconciles)
tar xzf "$TARBALL_PATH" -C "$METABOT_HOME"

PACKAGE_DEFAULT_ENV="$METABOT_HOME/.metabot-package/default.env"
if [[ -f "$PACKAGE_DEFAULT_ENV" ]]; then
  mkdir -p "$HOME/.metabot"
  cp "$PACKAGE_DEFAULT_ENV" "$HOME/.metabot/default.env"
  chmod 600 "$HOME/.metabot/default.env"
  rm -rf "$METABOT_HOME/.metabot-package"
  success "Installed internal default env at $HOME/.metabot/default.env"
fi

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
