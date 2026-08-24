# External MCP Products

MetaBot can expose independently installed stdio MCP products to a Bot. The
same installed command can also be registered directly in Codex or Claude;
MetaBot does not wrap the product protocol, issue product credentials, or own
the product process beyond the stdio child started by the client.

Configure products on each Bot with `mcpServers`. Presence is not enough:
`enabled` must be exactly `true`, so every Bot opts in explicitly.

```json
{
  "name": "research-bot",
  "engine": "codex",
  "defaultWorkingDirectory": "/absolute/project/path",
  "mcpServers": [
    {
      "name": "installed-product",
      "enabled": true,
      "command": "your-installed-mcp",
      "args": ["--stdio"],
      "env": {
        "PRODUCT_MODE": "read-only"
      },
      "approvalMode": "writes",
      "enabledTools": ["read", "write"],
      "toolApprovals": {
        "read": "approve",
        "write": "prompt"
      }
    }
  ]
}
```

`command` must be an executable discoverable on `PATH` or an absolute
executable path. Relative repository paths are rejected. MetaBot resolves each
entry independently; a missing executable or invalid descriptor removes only
that MCP product and leaves the Bot and its other MCP products available.

`approvalMode` is required and uses Codex's native MCP approval modes:
`auto`, `prompt`, `writes`, or `approve`. `enabledTools`, `disabledTools`, and
`toolApprovals` are optional. Claude receives the same server name, command,
arguments, and product environment through its native additive MCP config.
Existing user and project MCP settings remain enabled.

Use `env` only for non-secret product configuration. `envFrom` can map a
product variable to an existing host variable without putting its value in
Codex arguments:

```json
{
  "envFrom": {
    "PRODUCT_CONFIG_PATH": "HOST_PRODUCT_CONFIG_PATH"
  }
}
```

Credentials should remain in the product's own keychain, protected file, or
other documented security channel. MetaBot does not mint capabilities, store
product private keys, manage product databases, start product services, or use
the Bot name or chat ID as an MCP identity.

For Claude's persistent CLI backend, MetaBot writes an additive per-executor
config with mode `0600` inside a `0700` temporary directory and removes it when
the executor closes. It never enables strict MCP mode, so a failed external
product cannot replace or disable the user's other MCP configuration.
