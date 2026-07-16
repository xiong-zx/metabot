# MetaMemory

Embedded knowledge store with full-text search. Agents read/write Markdown documents across sessions. Shared by all agents in the organization.

## Overview

MetaMemory is a **SQLite-based document store** (using FTS5 for full-text search) that provides persistent knowledge for all agents. It runs as an embedded server within MetaBot.

- **Documents** are Markdown files organized in a folder tree
- **Full-text search** via SQLite FTS5
- **Web UI** at `http://localhost:8100?token=YOUR_TOKEN` for browsing and searching
- **REST API** for programmatic access
- **CLI** (`mm`) for terminal access

## Memory Core vs MetaMemory

MetaMemory is the human-readable knowledge layer. Memory Core is the execution memory layer for agents and workers.

| System | Stores | Main readers | Execution-critical fact source |
|--------|--------|--------------|--------------------------------|
| MetaMemory | Markdown blueprints, weekly reports, meeting notes, project docs, curated summaries | Humans and agents | No |
| Memory Core | Traceable events, memory units, negative results, decisions, context pack evidence | Agents and workers | Yes |

After an AutoResearchClaw run, reliable facts first go into Memory Core. Human-readable summaries, reports, and architecture notes can then be published to MetaMemory. Do not use MetaMemory documents as a substitute for execution-critical research facts or project context packs.

Public MetaMemory API writes are limited to `/users`, `/shared`, and `/metabot` by default. This prevents agents from pretending that arbitrary project roots, system paths, or experiment directories are MetaMemory folders. To extend writable public namespaces, configure `METABOT_CORE_MEMORY_WRITE_ROOTS` explicitly.

## How Agents Use It

Claude autonomously reads/writes memory documents via the `metamemory` skill. When users say "remember this" or Claude wants to persist knowledge, it calls the memory API.

```
Remember the deployment guide we just discussed — save it to MetaMemory
under /projects/deployment.
```

```
Search MetaMemory for our API design conventions.
```

## Chat Commands

| Command | Description |
|---------|-------------|
| `/memory list` | Browse knowledge tree |
| `/memory search <query>` | Search knowledge base |
| `/memory status` | Show MetaMemory status |

These commands get quick responses without spawning Claude — they use the `MemoryClient` HTTP client directly.

## CLI (`mm`)

```bash
# Read
mm search "deployment guide"        # full-text search
mm list                             # list documents
mm folders                          # folder tree
mm path /projects/my-doc            # get doc by path

# Write
echo '# Notes' | metabot memory create "Title" --share --tags "dev,team"
echo '# Updated' | metabot memory update DOC_ID --share --tags "dev,team"
metabot memory share DOC_ID on       # make an existing doc cross-bot readable
mm mkdir "new-folder"               # create folder
mm delete DOC_ID                    # delete document
```

## Web UI Access

When auth is configured (`API_SECRET`, `MEMORY_ADMIN_TOKEN`, or `MEMORY_TOKEN`), the Web UI requires a token. Pass it via URL query parameter:

```
http://localhost:8100?token=YOUR_TOKEN
```

The full URL with token is printed to logs on startup. The token is saved to `localStorage` in the browser, so you only need to pass it once. You can also set or clear the token from the settings icon in the Web UI.

## Access Control

MetaMemory supports folder-level ACL:

| Token | Access |
|-------|--------|
| `MEMORY_ADMIN_TOKEN` | Full access — sees all folders |
| `MEMORY_TOKEN` | Reader access — shared folders only |

See [Security](../concepts/security.md#metamemory-access-control) for details.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `MEMORY_ENABLED` | `true` | Enable MetaMemory |
| `MEMORY_PORT` | `8100` | MetaMemory port |
| `MEMORY_ADMIN_TOKEN` | — | Admin token (full access) |
| `MEMORY_TOKEN` | — | Reader token (shared only) |
| `META_MEMORY_URL` | `http://localhost:8100` | MetaMemory URL (for CLI) |
| `METABOT_CORE_MEMORY_WRITE_ROOTS` | `/users,/shared,/metabot` | Top-level paths that public Memory API write calls may create/update; comma-separated |

## Auto-Sync to Wiki

MetaMemory changes can automatically sync to a Feishu Wiki space. See [Wiki Sync](wiki-sync.md) for details.
