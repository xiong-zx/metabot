# Wiki Sync

One-way sync from MetaMemory documents to a Feishu Wiki space. The folder tree in MetaMemory maps to wiki nodes; each document becomes a Feishu docx page.

## Overview

When enabled, MetaMemory content can be synchronized to a Feishu Wiki space:

- **Folder tree** maps to wiki node hierarchy
- **Documents** become Feishu docx pages
- **Change detection** uses hash comparison for incremental sync
- **Root isolation** confines every write to one configured Wiki subtree

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
| `WIKI_SYNC_STATE_DIR` | `./data` | Directory containing the target-bound mapping database |
| `WIKI_SYNC_DELETE_REMOTE` | `false` | Delete mapped Wiki pages after Memory deletion; requires a root token |
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

- Remote deletion is opt-in. Before update, move, or deletion, mapped nodes are
  checked to be descendants of the configured root.

For multiple hosts in one Space, give each host a different root node and state
directory so their target bindings and mappings remain independent.

Do not point populated sync state at another Space or root. Target bindings are
immutable; use a new empty `WIKI_SYNC_STATE_DIR` when changing targets.

## API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/sync` | Trigger full sync |
| `GET` | `/api/sync` | Sync status |
| `POST` | `/api/sync/document` | Sync single document by ID |
