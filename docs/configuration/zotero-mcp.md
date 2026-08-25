# Zotero MCP

MetaBot uses the upstream `zotero-mcp` product directly. It does not fork,
wrap, publish, start, or own Zotero logic. The same installed command is used by
Codex CLI/Desktop, Claude CLI/Desktop, and a MetaBot Bot:

```text
zotero-mcp
```

Install and configure Zotero MCP through its own documented setup flow. Version
0.10.0 or later supports the standalone command used here. Local mode talks to
Zotero's Local API and does not put a web API credential in `bots.json`.

Codex:

```bash
codex mcp add --env ZOTERO_LOCAL=true zotero -- zotero-mcp
```

Claude Code:

```bash
claude mcp add --transport stdio --env ZOTERO_LOCAL=true zotero -- zotero-mcp
```

MetaBot Bot entry:

```json
{
  "mcpServers": [
    {
      "name": "zotero",
      "enabled": true,
      "command": "zotero-mcp",
      "args": [],
      "env": { "ZOTERO_LOCAL": "true" },
      "approvalMode": "writes"
    }
  ]
}
```

`writes` uses the MCP tool annotations to approve read-only tools and request
approval for writes in Codex. Zotero remains responsible for its Local/Web API
configuration and credentials. Do not put a Zotero API key in the descriptor;
use Zotero MCP's own protected credential channel if web or write access is
needed.

The descriptor does not filter tools, so every client receives the upstream
tool names, schemas, and result contracts. A missing `zotero-mcp` executable
removes only this entry and leaves every other external MCP product available.

A minimal read-only acceptance is:

1. initialize the MCP process and list tools;
2. call `zotero_get_recent` with `limit: 1`;
3. verify a non-error, non-empty result without copying private library content
   into logs.
