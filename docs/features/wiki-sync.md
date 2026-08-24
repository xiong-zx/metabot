# Wiki Sync

One-way sync from MetaMemory documents to a Feishu Wiki space. The folder tree in MetaMemory maps to wiki nodes; each document becomes a Feishu docx page.

## Overview

When enabled, MetaMemory content can be synchronized to a Feishu Wiki space:

- **Folder tree** maps to wiki node hierarchy
- **Documents** become Feishu docx pages
- **Change detection** uses hash comparison for incremental sync
- **Root isolation** confines every write to one configured Wiki subtree
- **Auto-sync** can consume MetaMemory's durable change feed (5-second polling by default)

## Chat Commands

| Command | Description |
|---------|-------------|
| `/sync` | Trigger full sync |
| `/sync status` | Show sync statistics |

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `WIKI_SYNC_ENABLED` | `true` | Enable wiki sync |
| `WIKI_SPACE_ID` | — | Feishu Wiki space ID |
| `WIKI_SPACE_NAME` | `MetaMemory` | Wiki space name (created if not exists) |
| `WIKI_SYNC_ROOT_NODE_TOKEN` | — | Immutable parent node for this host's complete sync tree |
| `WIKI_SYNC_SOURCE_ROOT` | `/` | MetaMemory subtree projected directly onto the configured Wiki root |
| `WIKI_SYNC_STATE_DIR` | `./data` | Directory containing the target-bound mapping database |
| `WIKI_SYNC_DELETE_REMOTE` | `false` | Delete mapped Wiki pages after Memory deletion; requires a root token |
| `WIKI_AUTO_SYNC` | `false` | Consume Memory changes automatically |
| `WIKI_AUTO_SYNC_CONSUMER` | target hash | Optional durable cursor name |
| `WIKI_AUTO_SYNC_POLL_MS` | `5000` | Change-feed polling interval |
| `WIKI_AUTO_SYNC_BATCH_SIZE` | `100` | Maximum events processed per poll |
| `WIKI_AUTO_SYNC_FULL_RECONCILE_MS` | `21600000` | Periodic full reconciliation interval |
| `WIKI_AUTO_SYNC_MAX_ATTEMPTS` | `5` | Retries before a batch is dead-lettered |
| `WIKI_AUTO_SYNC_WATCH_ROOT` | source root | Legacy alias for `WIKI_SYNC_SOURCE_ROOT`; explicit values must match |
| `WIKI_SYNC_THROTTLE_MS` | `300` | Delay between API calls |
| `FEISHU_SERVICE_APP_ID` | — | Dedicated Feishu app for sync (falls back to first bot) |
| `FEISHU_SERVICE_APP_SECRET` | — | Service app secret |

## Required Feishu Permissions

Add these in the Feishu Developer Console:

- `wiki:wiki` — Read/write wiki pages
- `docx:document` — Create/edit documents
- `docx:document:readonly` — Read documents
- `drive:drive` — Access drive files

## Root Isolation and Deletion

Auto-sync fails closed unless `WIKI_SPACE_ID`, `WIKI_SYNC_ROOT_NODE_TOKEN`,
and `WIKI_SYNC_STATE_DIR` are all explicit. Its first run performs a full
snapshot and initializes a durable consumer at the event head. Later changes
are batched by document; the cursor advances only after a complete batch
succeeds. Failed batches survive Bridge restarts and become dead letters after
the configured retry limit. Periodic full reconciliation covers changes not
represented by document events, and manual `/sync` remains available.

- Remote deletion is opt-in. Before update, move, or deletion, mapped nodes are
  checked to be descendants of the configured root.
- `WIKI_SYNC_SOURCE_ROOT=/imac` projects the contents of Memory `/imac`
  directly below the configured Wiki root; it does not create another `imac`
  node. Full reconciliation and incremental events use the same source boundary.

For multiple hosts in one Space, give each host a different root node and state
directory so their target bindings and mappings remain independent. The default
consumer name is derived from the Space and root token, so hosts sharing one
Memory Core do not consume each other's cursor.

Do not point populated sync state at another Space, Wiki root, or Memory source.
Target bindings are immutable; use a new empty `WIKI_SYNC_STATE_DIR` when any
of them changes.

## API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/sync` | Trigger full sync |
| `GET` | `/api/sync` | Sync status |
| `POST` | `/api/sync/document` | Sync single document by ID |
