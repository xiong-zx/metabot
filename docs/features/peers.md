# Peers Federation

Cross-instance bot discovery and task routing. Connect multiple MetaBot instances — on the same machine or across remote servers.

## Overview

Peers enables a **federated architecture** where multiple MetaBot instances discover each other's bots and route tasks automatically. This is useful when:

- Multiple users on the same machine run separate MetaBot instances
- Teams deploy MetaBot on different servers
- You want to share specialized bots across environments

## How It Works

1. **Discovery** — Each instance periodically polls its peers' `GET /api/bots` endpoint (every 30 seconds)
2. **Caching** — Bot lists are cached locally for fast lookups
3. **Routing** — When a bot name isn't found locally, the request is forwarded to the peer that has it
4. **Anti-loop** — Forwarded requests carry `X-MetaBot-Origin` header to prevent circular delegation
5. **Anti-transitive** — Bots that are themselves from a peer are filtered out (no transitive forwarding)

## Configuration

Configure peers via **either** method — or use both (they are merged and deduplicated by URL):

For peers on remote servers, prefer HTTPS URLs fronted by Caddy or another TLS reverse proxy. Plain `http://` is best kept to `localhost` or a private overlay network such as Tailscale or WireGuard.

=== "Environment Variables (.env)"

    The simplest way — just add to your `.env` file. Works with both single-bot and multi-bot mode.

    ```bash
    METABOT_PEER_ID=imac
    METABOT_PEERS=http://localhost:9200,http://192.168.1.50:9100
    METABOT_PEER_NAMES=alice,bob
    METABOT_PEER_KEY_IDS=imac-alice-v1,imac-bob-v1
    METABOT_PEER_AUTH_SECRETS=<alice-peer-secret>,<bob-peer-secret>
    METABOT_PEER_SOURCE_BOTS=local-bot,local-bot
    ```

    - `METABOT_PEER_ID` — stable identity of this Bridge (required for scoped peer auth)
    - `METABOT_PEERS` — comma-separated peer URLs (required)
    - `METABOT_PEER_NAMES` — comma-separated display names (optional, auto-derived from URL if omitted, e.g. `localhost-9200`)
    - `METABOT_PEER_KEY_IDS` — comma-separated peer key IDs
    - `METABOT_PEER_AUTH_SECRETS` — comma-separated peer-scoped secrets, positional match with URLs
    - `METABOT_PEER_SOURCE_BOTS` — optional local Bot names used for outbound tasks

    Store peer secrets only in the local secret channel used for `.env`; never
    commit or print them. `METABOT_PEER_SECRETS` is a deprecated legacy setting.
    Its values are detected but are never sent as Bridge administrator auth.

=== "bots.json"

    If you already use `bots.json` for multi-bot mode, you can add peers there for a single config file.

    ```json
    {
      "feishuBots": [{ "..." }],
      "peers": [
        {
          "name": "alice",
          "url": "http://localhost:9200",
          "auth": {
            "keyId": "imac-alice-v1",
            "secret": "<peer-scoped-secret>",
            "sourceBot": "imac-bot",
            "allowedSourceBots": ["alice-bot", "bridge:alice"],
            "allowedTargetBots": ["imac-bot"]
          }
        }
      ]
    }
    ```

    - `name` — display name for the peer (required)
    - `url` — peer's API URL (required)
    - `auth.keyId` — non-secret identifier for the active peer key
    - `auth.secret` — peer-scoped secret of at least 32 characters; it is not a Bridge `API_SECRET`
    - `auth.sourceBot` — explicit local Bot used as the signed outbound task identity
    - `allowedSourceBots` / `allowedTargetBots` — optional inbound Bot scopes

    Set `METABOT_PEER_ID` for this Bridge. On the other Bridge, use that value
    as the peer `name`; use the other Bridge's identity as this entry's `name`.
    Keep `bots.json` mode `0600` and outside model workspaces when it contains
    local credentials.

Expose peer URLs only over loopback, a private network, or your own authenticated
HTTPS reverse proxy.

## Authentication and permissions

Static Bridge peers use a short-lived HMAC capability in the
`Authorization: MetaBotPeer ...` header. Each request binds the issuer, target
Bridge and HTTP Host, method and path, source and target Bot, optional RulesPack
issuer, chat ID, request ID, body SHA-256 digest, issue/expiry times, and a one-use nonce. The default
lifetime is 30 seconds. Replays, altered bodies, wrong routes, expired tokens,
unknown issuers, and revoked keys fail closed with stable error codes.

`auth.sourceBot` and a RulesPack envelope issuer are separate identities. The
former must name a Bot on the sending Bridge and is bound to the peer task; the
latter remains the authenticated RulesPack transport identity and is signed as
its own capability claim. Configure `sourceBot` when several local Bots can
compile an outbound RulesPack so the Bridge never guesses which operator owns
the dispatch.

Peer capabilities can access only:

- read-only Bot, Skill, and peer discovery;
- `POST /api/talk` (or its deprecated `/api/tasks` alias); and
- `GET /api/talk/:requestId` for the same peer-scoped asynchronous request.

They cannot access Bot or peer CRUD, schedules, runtime restart/deploy,
Agent Teams management, sessions, files, databases, or other administrator
routes. Same-Core registry relay may continue to use its Core bearer. Static
peers never fall back to a Core bearer or `API_SECRET`.

Peer sends use one request ID from acceptance through terminal status. A lost
POST response can be retried with a new nonce and the same request ID; the
receiver returns the existing task instead of executing it twice.

## Rotation, revocation, and legacy migration

For rotation, first stage the new key under `auth.acceptKeys` on both receivers
with a bounded `acceptUntil`. Then promote it to `auth.keyId`/`auth.secret` on
both sides and keep the old key under `acceptKeys` only for the overlap. Finally
remove it or add its key ID to `revokedKeyIds`. Removing a peer also revokes its
inbound trust immediately.

Legacy `peer.secret` / `METABOT_PEER_SECRETS` configurations appear as
`legacy_secret_rejected` in peer status and are not transmitted. Migrate both
Bridges by assigning stable peer IDs and a unique peer-scoped key, confirm
bidirectional discovery and talk in staging, then remove the legacy field.
Back up the local configuration before migration. Code rollback restores the
previous release and configuration, but it also restores administrator-secret
peer auth and should be treated as a temporary security rollback.

!!! tip "You don't need bots.json"
    If you're running a single bot, just add `METABOT_PEERS` to your `.env` — no `bots.json` needed. The `bots.json` peers field is only a convenience for multi-bot setups.

## Qualified Names

Use `peerName/botName` syntax for precise routing:

```bash
# Auto-routing — searches local first, then peers in order
metabot talk backend-bot chatId "fix the bug"

# Explicit peer — routes directly to alice's backend-bot
metabot talk alice/backend-bot chatId "fix the bug"
```

## API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/peers` | List peers and their health status |
| `GET` | `/api/bots` | List all bots (local + peer) |
| `POST` | `/api/talk` | Talk to a bot (auto-routes to peers) |

## CLI

```bash
metabot peers                            # list peers and status
metabot bots                             # list all bots (includes peer bots)
metabot talk alice/bot chatId "prompt"   # talk to a specific peer's bot
```

## Health Monitoring

Each peer is polled every 30 seconds. The `GET /api/peers` endpoint returns health status:

```json
[
  {
    "name": "alice",
    "url": "http://localhost:9200",
    "healthy": true,
    "lastChecked": 1710000000000,
    "lastHealthy": 1710000000000,
    "botCount": 3,
    "authMode": "peer_capability"
  }
]
```

Unhealthy peers are retried on the next poll cycle. Their cached bot lists are cleared when they become unreachable.
