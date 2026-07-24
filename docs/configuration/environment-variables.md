# Environment Variables

All configuration is via `.env` file or system environment variables. Copy `.env.example` to `.env` to get started.

## MetaBot Core

| Variable | Default | Description |
|----------|---------|-------------|
| `METABOT_HOME` | `process.cwd()` | MetaBot runtime directory. Written to `.env` and exported to your shell profile by the installer. `$METABOT_HOME/CLAUDE.md` (with `AGENTS.md` alongside it) holds the host-wide project rules, which the bridge injects into **every** bot's system prompt — see [Host instructions](#host-instructions) |
| `BOTS_CONFIG` | — | Path to `bots.json` for multi-bot mode |
| `FEISHU_APP_ID` | — | Feishu app ID (single-bot mode) |
| `FEISHU_APP_SECRET` | — | Feishu app secret (single-bot mode) |
| `API_PORT` | `9100` | HTTP API port |
| `API_SECRET` | — | Bearer token auth for API and MetaMemory. Generate one with `openssl rand -hex 32` |
| `LOG_LEVEL` | `info` | Log level (debug, info, warn, error) |
| `METABOT_LOCAL_ADDRESS` | — | Bind all Feishu sockets (REST + wss long-connection) to this local source IP, forcing source-based routing past VPN smart split-tunneling (e.g. a corporate VPN hijacking `*.feishu.cn` into a dead tunnel). Unset = default route |
| `METABOT_PUBLIC_DISTRIBUTION` | — | metabot-core server flag. The `/cli/*` and `/install/*` install endpoints are token-gated by default; set to `1` (or `true`) to serve them anonymously. Only enable when you intentionally self-distribute and your build embeds no secrets |

### Host instructions

`$METABOT_HOME/CLAUDE.md` is MetaBot's only cross-host channel for project
rules — MetaMemory is per-server and not shared, so what is checked into the
runtime directory is what every bot on that machine obeys. `AGENTS.md` sits
next to it (a symlink on POSIX, a copy on Windows) so the Codex and Kimi
engines find it too.

The agent engines only auto-load `CLAUDE.md` / `AGENTS.md` by walking *up*
from the session working directory. Bots whose working directory lives outside
`METABOT_HOME` would therefore never see these rules, so the bridge reads the
file at session spawn and appends it to the system prompt instead. That path is
engine-independent (Claude, Codex and Kimi alike) and applies to every bot, not
just ones with `pmPrompt: true`.

Injection is **skipped** when the bot's working directory is inside
`METABOT_HOME` — the engine's own auto-load already covers it, and injecting
would duplicate the content. Files over 128 KiB are truncated with a marker;
a missing or unreadable file is logged at debug level and skipped, never fatal.

## Claude Code

| Variable | Default | Description |
|----------|---------|-------------|
| `DEFAULT_WORKING_DIRECTORY` | — | Working directory for Claude (single-bot mode) |
| `CLAUDE_MAX_TURNS` | unlimited | Max turns per request |
| `CLAUDE_MAX_BUDGET_USD` | unlimited | Max cost per request (USD) |
| `CLAUDE_MODEL` | SDK default | Claude model to use |
| `CLAUDE_EXECUTABLE_PATH` | auto-detect | Path to `claude` binary |

## Codex CLI

| Variable | Default | Description |
|----------|---------|-------------|
| `CODEX_MODEL` | Codex default | Codex model to use |
| `CODEX_API_KEY` | — | OpenAI-compatible API key for Codex. Normalized to `OPENAI_API_KEY` in the Codex child process |
| `CODEX_BASE_URL` | Codex default | OpenAI-compatible API base URL. Passed to Codex as `-c openai_base_url="..."` |
| `CODEX_PROFILE` | — | Codex config profile |
| `CODEX_APPROVAL_POLICY` | `never` | Approval policy (`untrusted`, `on-failure`, `on-request`, `never`) |
| `CODEX_SANDBOX` | `danger-full-access` | Sandbox mode (`read-only`, `workspace-write`, `danger-full-access`) |
| `CODEX_EXECUTABLE_PATH` | auto-detect | Path to `codex` binary |

`read-only` and `workspace-write` rely on Codex CLI's Bubblewrap namespace
sandbox. In Docker/Kubernetes runtimes with restricted user namespaces,
seccomp, or AppArmor, tool calls can fail with `bwrap: No permissions to create
new namespace`. Run `metabot doctor --json` and check
`codex_sandbox_namespaces` before assigning sandboxed Codex workers. Use
`danger-full-access` / bot-level bypass on restricted hosts, or run the
container with user namespaces allowed by host policy.

## MetaMemory

| Variable | Default | Description |
|----------|---------|-------------|
| `MEMORY_ENABLED` | `true` | Enable embedded MetaMemory |
| `MEMORY_PORT` | `8100` | MetaMemory port |
| `MEMORY_SECRET` | `API_SECRET` | MetaMemory auth (legacy) |
| `MEMORY_ADMIN_TOKEN` | — | Admin token (full access) |
| `MEMORY_TOKEN` | — | Reader token (shared folders only) |
| `META_MEMORY_URL` | `http://localhost:8100` | MetaMemory URL (for CLI remote access) |
| `METABOT_CORE_MEMORY_WRITE_ROOTS` | `/users,/shared,/metabot` | Top-level paths that public Memory API write calls may create/update; comma-separated |
| `METABOT_CORE_MEMORY_SERVER_ROOT` | — | This server's top-level MetaMemory namespace, for example `/cargo1`; appended to Memory API writable roots when set |
| `METABOT_ASYNC_TASK_STALE_MS` | `86400000` | Mark `/api/talk?async=true` tasks as `task_expired` when they exceed this runtime without completing |

## Feishu Service App

| Variable | Default | Description |
|----------|---------|-------------|
| `FEISHU_SERVICE_APP_ID` | — | Dedicated app for wiki sync & doc reader |
| `FEISHU_SERVICE_APP_SECRET` | — | Service app secret |

Falls back to the first Feishu bot's credentials if not set.

## Wiki Sync

| Variable | Default | Description |
|----------|---------|-------------|
| `WIKI_SYNC_ENABLED` | `true` | Enable MetaMemory → Wiki sync |
| `WIKI_SPACE_ID` | — | Feishu Wiki space ID |
| `WIKI_SPACE_NAME` | `MetaMemory` | Wiki space name |
| `WIKI_AUTO_SYNC` | `true` | Auto-sync on changes |
| `WIKI_AUTO_SYNC_ON_START` | `true` | Run one sync after the startup baseline is captured |
| `WIKI_AUTO_SYNC_POLL_MS` | `60000` | Snapshot polling interval |
| `WIKI_AUTO_SYNC_DEBOUNCE_MS` | `5000` | Debounce delay |
| `WIKI_SYNC_THROTTLE_MS` | `300` | Delay between API calls |

## Peers Federation

| Variable | Default | Description |
|----------|---------|-------------|
| `METABOT_PEERS` | — | Comma-separated peer URLs. Prefer HTTPS for internet-reachable peers; use plain HTTP only for localhost or a private overlay network |
| `METABOT_PEER_SECRETS` | — | Comma-separated peer secrets (positional match) |
| `METABOT_PEER_NAMES` | auto | Comma-separated peer names |
| `METABOT_PEER_POLL_INTERVAL_MS` | `30000` | Peer poll interval |
| `METABOT_ALLOWED_PEER_CIDRS` | — | Optional comma/space-separated IPv4 CIDR allowlist. When set, task forwarding only targets peers whose literal-IPv4 host falls inside one of these ranges. Hostname-based peers are still gated by the known-peer allowlist but are not CIDR-filtered. Unset = no CIDR constraint. Example: `10.0.0.0/8,192.168.0.0/16` |

## Remote Access

| Variable | Default | Description |
|----------|---------|-------------|
| `METABOT_URL` | `http://localhost:9100` | MetaBot API URL for CLI. The default is local HTTP; for remote access prefer an HTTPS reverse proxy or a private-network address |
| `META_MEMORY_URL` | `http://localhost:8100` | MetaMemory URL for CLI. The default is local HTTP; for remote access prefer an HTTPS reverse proxy or a private-network address |

## Voice

| Variable | Default | Description |
|----------|---------|-------------|
| `VOLCENGINE_TTS_APPID` | — | Doubao STT + TTS (recommended) |
| `VOLCENGINE_TTS_ACCESS_KEY` | — | Doubao STT + TTS (recommended) |
| `VOLCENGINE_TTS_RESOURCE_ID` | `volc.service_type.10029` | Doubao TTS resource ID |
| `OPENAI_API_KEY` | — | Fallback for Whisper STT + OpenAI TTS |
| `ELEVENLABS_API_KEY` | — | ElevenLabs TTS |
| `VOICE_MODEL` | — | Override Claude model for voice mode |

## Third-Party AI Providers

MetaBot supports any Anthropic-compatible API:

```bash
# Kimi/Moonshot
ANTHROPIC_BASE_URL=https://api.moonshot.ai/anthropic
ANTHROPIC_AUTH_TOKEN=your-key

# DeepSeek
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
ANTHROPIC_AUTH_TOKEN=your-key

# GLM/Zhipu
ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic
ANTHROPIC_AUTH_TOKEN=your-key
```
