# Environment Variables

Use `bots.json` for per-bot engine, workspace, and channel settings. Use `.env`
for deployment-wide runtime configuration. Copy `.env.example` and add only the
values you need.

## Core and Bridge

| Variable                        | Default                 | Purpose                                                                      |
| ------------------------------- | ----------------------- | ---------------------------------------------------------------------------- |
| `BOTS_CONFIG`                   | —                       | Path to multi-bot configuration, normally `./bots.json`                      |
| `METABOT_ENGINE`                | `codex`                 | Single-bot default: `codex`, `kimi`, or compatibility `claude`               |
| `API_PORT`                      | `9100`                  | Local Bridge API port                                                        |
| `API_SECRET`                    | —                       | Bridge Bearer secret; non-health API routes reject anonymous requests        |
| `API_HOST` / `METABOT_API_HOST` | `127.0.0.1`             | Bridge bind address; use `0.0.0.0` only behind your own private/TLS boundary |
| `METABOT_URL`                   | `http://localhost:9100` | Bridge URL used by local Bridge CLI commands                                 |
| `METABOT_CORE_URL`              | `http://localhost:9200` | Core Console and delegated CLI URL                                           |
| `METABOT_CORE_TOKEN`            | token file              | Overrides `~/.metabot-core/token`                                            |
| `METABOT_CORE_HOST`             | `127.0.0.1`             | Core bind address                                                            |
| `METABOT_CORE_PORT`             | `9200`                  | Core port                                                                    |
| `METABOT_CORE_DATA_DIR`         | `~/.metabot-core/data`  | Core data directory                                                          |
| `METABOT_PUBLIC_DISTRIBUTION`   | `0`                     | Serve Core install/CLI assets anonymously; enable only intentionally         |
| `METABOT_NODE_INTERPRETER`      | current `node` executable | Absolute Node.js >=22.19 path pinned into every PM2 app                      |
| `LOG_LEVEL`                     | `info`                  | Bridge log level                                                             |

Memory, Skills, Agents, and T5T are served by Core at `METABOT_CORE_URL`. The
old standalone MetaMemory variables and port `8100` are not part of the current
Personal Edition.

## Execution daemons

| Variable | Default | Purpose |
|---|---|---|
| `METABOT_STATE_DIR` | `~/.metabot` | Parent for MetaBot and Worker Runner state |
| `METABOT_KEYS_DIR` | `~/.metabot/keys` | Out-of-runtime Worker Runner Ed25519 keys |
| `METABOT_WORKER_DAEMON_URL` | `http://127.0.0.1:9311/mcp` | Worker Runner loopback MCP endpoint |
| `METABOT_WORKER_DATA_DIR` | `~/.metabot/worker-runner` | Worker Runner SQLite state and exclusive lock |
| `METABOT_WORKER_ENV_ALLOWLIST` | ordinary proxy names | Extra non-secret child environment names |

The lifecycle probes make authenticated, read-only MCP calls; there is no
unauthenticated daemon health endpoint. Daemon callbacks use the Bridge port
and a distinct callback signing key. The private key remains outside the
replaceable runtime checkout.

## Workspace and engines

| Variable                           | Default                  | Purpose                                                       |
| ---------------------------------- | ------------------------ | ------------------------------------------------------------- |
| `CLAUDE_DEFAULT_WORKING_DIRECTORY` | —                        | Historical single-bot workspace variable used by every engine |
| `CODEX_MODEL`                      | Codex default            | Codex model                                                   |
| `CODEX_PROFILE`                    | —                        | Codex configuration profile                                   |
| `CODEX_API_KEY`                    | login state              | OpenAI-compatible key, normalized to `OPENAI_API_KEY`         |
| `CODEX_BASE_URL`                   | Codex default            | OpenAI-compatible API base URL                                |
| `CODEX_APPROVAL_POLICY`            | `never`                  | Codex approval policy                                         |
| `CODEX_SANDBOX`                    | `workspace-write`        | Codex sandbox mode                                            |
| `CODEX_REASONING_EFFORT`           | —                        | `low`, `medium`, `high`, `xhigh`, `max`, or `ultra`           |
| `CODEX_EXECUTABLE_PATH`            | auto                     | Codex binary path                                             |
| `KIMI_CODE_SERVER_URL`             | `http://127.0.0.1:58627` | Existing local Kimi Server; otherwise started on demand       |
| `KIMI_CODE_HOME`                   | `~/.kimi-code`           | Kimi configuration and local token directory                  |
| `KIMI_API_KEY`                     | login state              | Optional provider key inherited by local Kimi Server          |
| `CLAUDE_MODEL`                     | Claude default           | Compatibility-engine model                                    |
| `CLAUDE_EXECUTABLE_PATH`           | auto                     | Claude compatibility binary path                              |

Prefer per-bot `workspace`, `engine`, model, sandbox, and Kimi permission
settings in `bots.json`. See [Multi-Bot and Engines](multi-bot.md).

## Channels

| Variable                                 | Default | Purpose                                                         |
| ---------------------------------------- | ------- | --------------------------------------------------------------- |
| `FEISHU_APP_ID`                          | —       | Single-bot Feishu/Lark App ID                                   |
| `FEISHU_APP_SECRET`                      | —       | Single-bot Feishu/Lark App Secret                               |
| `FEISHU_DOMAIN`                          | `feishu`| API tenant: `feishu` or `lark`; other values are rejected       |
| `TELEGRAM_BOT_TOKEN`                     | —       | Single-bot Telegram token                                       |
| `SLACK_BOT_TOKEN`                        | —       | Single-bot Slack bot token (`xoxb-...`)                         |
| `SLACK_SIGNING_SECRET`                   | —       | Single-bot Slack Events API signing secret                      |
| `SLACK_BOT_USER_ID`                      | auto    | Optional Slack bot user ID when startup cannot call `auth.test` |
| `SLACK_GROUP_NO_MENTION`                 | `false` | Route all Slack channel messages instead of mention-only        |
| `METABOT_FEISHU_WS_PING_TIMEOUT_SEC`     | `20`    | Feishu WebSocket pong timeout                                   |
| `METABOT_FEISHU_WS_HANDSHAKE_TIMEOUT_MS` | `15000` | Feishu connect/reconnect timeout                                |
| `METABOT_LOCAL_ADDRESS`                  | —       | Optional source IP for Feishu sockets                           |

Multi-bot deployments should store channel credentials in the protected
`bots.json` rather than duplicating them in `.env`.

## Optional services

| Variable | Default | Purpose |
|---|---|---|
| `METABOT_CORE_MEMORY_WRITE_ROOTS` | `/users,/shared,/metabot` | Top-level paths that public Memory API writes may create or update |
| `METABOT_CORE_MEMORY_SERVER_ROOT` | — | This server's additional top-level MetaMemory namespace, for example `/cargo1` |
| `METABOT_MEMORY_INDEX_AUTOMATION` | `off` | Incremental index mode: `off`, `events` (outbox only), `dry-run`, `routing`, or dual-gated `full` |
| `METABOT_MEMORY_INDEX_QUALITY_APPROVED` | `false` | Operator attestation that the documented P5 quality contract passed; required by `full` |
| `METABOT_MEMORY_INDEX_AUTO_APPLY_ENABLED` | `false` | Independent P5 status-write kill switch; required by `full` |
| `METABOT_MEMORY_INDEX_WATCH_ROOT` | server root or `/cargo1` | Semantic scope watched by the index consumer |
| `METABOT_MEMORY_INDEX_STATUS_PATH` | `<watch-root>/status/project-progress-status` | Curated status document used for dry-run proposals |
| `METABOT_MEMORY_INDEX_TARGET_BOT` | `memory` | Bot used for bounded semantic status proposals |
| `METABOT_MEMORY_INDEX_CONSUMER` | mode-specific | Durable event-consumer cursor name; defaults to `memory-status-full` in `full`, otherwise `memory-status-dry-run` |
| `METABOT_MEMORY_INDEX_POLL_MS` | `60000` | Event poll interval |
| `METABOT_MEMORY_INDEX_RECONCILE_MS` | `900000` | Read-only reconciliation interval |
| `METABOT_MEMORY_INDEX_BATCH_SIZE` | `50` | Maximum events fetched per poll |
| `METABOT_MEMORY_INDEX_MAX_ATTEMPTS` | `3` | Retry count before dead-lettering a proposal failure |
| `METABOT_MEMORY_ROUTING_REBUILD_ENABLED` | `false` | Core-side write gate for deterministic routing-index rebuilds |
| `SCHEDULE_TIMEZONE` | system timezone | IANA timezone for cron tasks |
| `METABOT_PEERS` | — | Comma-separated peer URLs |
| `METABOT_PEER_SECRETS` | — | Positional secrets for peer URLs |
| `METABOT_PEER_NAMES` | auto | Positional peer display names |
| `METABOT_ALLOWED_PEER_CIDRS` | — | Optional IPv4 CIDR forwarding allowlist |
| `FEISHU_SERVICE_APP_ID` | first Feishu bot | Optional Wiki/doc-reader service app |
| `FEISHU_SERVICE_APP_SECRET` | first Feishu bot | Service app secret |
| `FEISHU_SERVICE_DOMAIN` | `feishu` | Dedicated service app tenant: `feishu` or `lark` |
| `WIKI_SYNC_ENABLED` | `true` | Enable optional Memory-to-Wiki sync |
| `WIKI_SPACE_ID` | — | Existing Wiki space ID |
| `WIKI_SPACE_NAME` | `MetaMemory` | Wiki space name |
| `WIKI_SYNC_ROOT_NODE_TOKEN` | — | Immutable parent node for this sync target |
| `WIKI_SYNC_SOURCE_ROOT` | `/` | MetaMemory subtree projected directly onto the Wiki root |
| `WIKI_SYNC_STATE_DIR` | `./data` | Target-bound mapping database directory |
| `WIKI_SYNC_DELETE_REMOTE` | `false` | Delete mapped Wiki pages; requires a root node |
| `WIKI_AUTO_SYNC` | `false` | Consume the durable Memory change feed automatically |
| `WIKI_AUTO_SYNC_CONSUMER` | target hash | Optional durable consumer cursor name |
| `WIKI_AUTO_SYNC_POLL_MS` | `5000` | Change-feed polling interval |
| `WIKI_AUTO_SYNC_BATCH_SIZE` | `100` | Maximum events processed per poll |
| `WIKI_AUTO_SYNC_FULL_RECONCILE_MS` | `21600000` | Periodic full reconciliation interval |
| `WIKI_AUTO_SYNC_MAX_ATTEMPTS` | `5` | Retries before a batch is dead-lettered |
| `WIKI_AUTO_SYNC_WATCH_ROOT` | source root | Legacy source-root alias; explicit values must match |
| `VOLCENGINE_TTS_APPID` | — | Doubao STT/TTS App ID |
| `VOLCENGINE_TTS_ACCESS_KEY` | — | Doubao STT/TTS access key |
| `OPENAI_API_KEY` | — | Optional Whisper/OpenAI TTS fallback |
| `ELEVENLABS_API_KEY` | — | Optional ElevenLabs TTS key |

The complete provider and RTC variable list remains documented inline in
`.env.example`, which is the source of truth for source deployments.

## Proxy

Standard `HTTP_PROXY`, `HTTPS_PROXY`, `http_proxy`, `https_proxy`, `NO_PROXY`,
and `no_proxy` variables are supported by the production daemons and are in
Worker Runner's default safe child allowlist. Secret-looking proxy variables
remain hard-denied even if named in `METABOT_WORKER_ENV_ALLOWLIST`.
Include `localhost` and `127.0.0.1` in `NO_PROXY` so Core, Bridge, and local Kimi
Server traffic stays local.

Never commit a populated `.env` or `bots.json`.
