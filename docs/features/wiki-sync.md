# Wiki Sync

One-way sync from MetaMemory documents to a Feishu Wiki space. The folder tree in MetaMemory maps to wiki nodes; each document becomes a Feishu docx page.

## Overview

When enabled, MetaMemory content automatically syncs to a Feishu Wiki space:

- **Folder tree** maps to wiki node hierarchy
- **Documents** become Feishu docx pages
- **Change detection** uses hash comparison for incremental sync
- **Auto-sync** triggers on MetaMemory changes (5-second debounce)
- **Root isolation** optionally confines the sync target to one Wiki subtree

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
| `WIKI_SYNC_ROOT_NODE_TOKEN` | — | Optional immutable root node for this sync target |
| `WIKI_AUTO_SYNC` | `true` | Auto-sync on MetaMemory changes |
| `WIKI_AUTO_SYNC_DEBOUNCE_MS` | `5000` | Debounce delay |
| `WIKI_SYNC_THROTTLE_MS` | `300` | Delay between API calls |
| `FEISHU_SERVICE_APP_ID` | — | Dedicated Feishu app for sync (falls back to first bot) |
| `FEISHU_SERVICE_APP_SECRET` | — | Service app secret |

## Root Isolation

Set `WIKI_SYNC_ROOT_NODE_TOKEN` to create all top-level folders and documents
below an existing Wiki node. The node must belong to `WIKI_SPACE_ID`.

Once mappings exist, their state directory is bound to the selected Space and
root. Use a new empty `WIKI_SYNC_STATE_DIR` when changing either value. Existing
state without a root token remains bound to the Space root.

## Required Feishu Permissions

Add these in the Feishu Developer Console:

- `wiki:wiki` — Read/write wiki pages
- `docx:document` — Create/edit documents
- `docx:document:readonly` — Read documents
- `drive:drive` — Access drive files

## Auto-Sync Behavior

- Changes trigger sync after a 5-second debounce
- Multiple rapid changes are coalesced
- 1-10 document changes → incremental sync
- Bulk changes or folder structure changes → full sync fallback
- Manual `/sync` is always available

## API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/sync` | Trigger full sync |
| `GET` | `/api/sync` | Sync status |
| `POST` | `/api/sync/document` | Sync single document by ID |
