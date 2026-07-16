# Wiki Sync

One-way sync from MetaMemory documents to a Feishu Wiki space. The folder tree in MetaMemory maps to wiki nodes; each document becomes a Feishu docx page.

## Overview

When enabled, MetaMemory content automatically syncs to a Feishu Wiki space:

- **Folder tree** maps to wiki node hierarchy
- **Documents** become Feishu docx pages
- **Change detection** hashes the MetaMemory folder tree plus document summaries
- **Auto-sync** polls for MetaMemory changes, then triggers sync after a debounce

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
| `WIKI_AUTO_SYNC` | `true` | Auto-sync on MetaMemory changes |
| `WIKI_AUTO_SYNC_ON_START` | `true` | Run one sync after the startup baseline is captured |
| `WIKI_AUTO_SYNC_POLL_MS` | `60000` | Snapshot polling interval |
| `WIKI_AUTO_SYNC_DEBOUNCE_MS` | `5000` | Debounce delay |
| `WIKI_SYNC_THROTTLE_MS` | `300` | Delay between API calls |
| `METABOT_CORE_MEMORY_SERVER_ROOT` | — | This server's top-level MetaMemory namespace, for example `/cargo1`; also appended to Memory API writable roots |
| `FEISHU_SERVICE_APP_ID` | — | Dedicated Feishu app for sync (falls back to first bot) |
| `FEISHU_SERVICE_APP_SECRET` | — | Service app secret |

## Multi-Server Sync

The syncer mirrors MetaMemory paths directly into the Wiki hierarchy. When multiple servers sync into the same `WIKI_SPACE_ID`, give each server its own top-level path:

- cargo1: `/cargo1/dev`, `/cargo1/ideas`, `/cargo1/ops`
- another server: `/<server-name>/dev`, `/<server-name>/ideas`, `/<server-name>/ops`

Set the local namespace and the shared Wiki space in each server's `.env`:

```bash
METABOT_CORE_MEMORY_SERVER_ROOT=/cargo1
WIKI_SPACE_ID=<shared_space_id>
WIKI_SYNC_ENABLED=true
WIKI_AUTO_SYNC=true
```

Migrate old data from `/metabot` into the server root:

```bash
metabot memory move-folder /metabot --path /cargo1
```

Folder and document IDs are preserved. After paths move, the next sync creates new Wiki mappings under the new hierarchy; old `/metabot` Wiki pages are not deleted automatically and should be cleaned up manually after verification.

## Create a Wiki Space

Prefer creating a dedicated Wiki space manually, or with user identity, then set `WIKI_SPACE_ID`. Do not rely on automatic space creation as the normal deployment path: creating a space requires user identity, while runtime sync usually runs as the app / bot identity.

Manual flow:

1. Open Feishu Wiki.
2. Create a team Wiki space, for example `MetaMemory`.
3. Open the Wiki space member / permission settings.
4. Add the MetaBot Feishu app as an app member; start with the regular member role.
5. Get the Wiki `space_id` and write it to `.env`.

CLI flow:

```bash
lark-cli auth login --scope "wiki:space:write_only wiki:space:retrieve wiki:member:create" --no-wait --json
lark-cli auth login --device-code <device_code>

lark-cli wiki +space-create \
  --name MetaMemory \
  --description "MetaBot MetaMemory sync target" \
  --as user \
  --format json

lark-cli wiki +member-add \
  --space-id <space_id> \
  --member-id <feishu_app_id> \
  --member-type appid \
  --member-role member \
  --as user
```

If you only have a Wiki URL, do not guess the `space_id`. Resolve the wiki token from the URL first:

```bash
lark-cli wiki spaces get_node \
  --params '{"token":"<wiki_token_from_url>"}' \
  --as user \
  --format json
```

Then set:

```bash
WIKI_SPACE_ID=<space_id>
```

## Required Feishu Permissions

Add these in the Feishu Developer Console:

- `wiki:wiki` — Read/write wiki pages
- `wiki:space:retrieve` — Read wiki space lists (optional when `wiki:wiki` already covers this ability)
- `docx:document` — Create/edit documents
- `docx:document:readonly` — Read documents
- `drive:drive` — Access drive files

If the logs show `99991672` or `99991663`, the Feishu app identity usually has not enabled the required Wiki scopes yet, or the app version has not been published. Enable the scopes in the Feishu Developer Console, publish the app version, then add the app to the target Wiki space. For an existing space, prefer setting `WIKI_SPACE_ID` directly so startup does not need to create a space.

## PM2 Environment Variables

The bridge reads `.env` on startup, but environment variables already present in the PM2 process take precedence. After changing `WIKI_*` settings, refresh the PM2 environment:

```bash
set -a
source /root/metabot/.env
set +a
pm2 restart metabot --update-env
```

## Auto-Sync Behavior

- The bridge polls MetaMemory snapshots every 60 seconds by default
- Snapshot changes trigger sync after a 5-second debounce
- Multiple rapid changes are coalesced
- Auto-sync calls the same full-sync pipeline as `/sync`
- Full sync uses content hashes to skip unchanged documents, so only changed pages are rewritten
- Manual `/sync` is always available

## API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/sync` | Trigger full sync |
| `GET` | `/api/sync` | Sync status |
| `POST` | `/api/sync/document` | Sync single document by ID |
