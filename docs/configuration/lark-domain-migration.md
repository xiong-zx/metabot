# Lark Domain Migration

MetaBot keeps the existing `feishuBots` channel and credential names for
backward compatibility. The new domain setting only selects which official API
tenant receives those credentials:

- `feishu` (default) uses the Feishu API.
- `lark` uses the international Lark API.

Only those two lowercase values are accepted. Existing configurations that do
not set a domain continue to use Feishu.

## Configure a Lark bot

Create and publish a custom app in the Lark developer console, enable its bot
capability, grant the same message/resource permissions, and configure the
persistent-connection event subscription. Then add the new Lark credentials:

```json
{
  "feishuBots": [{
    "name": "international-bot",
    "feishuAppId": "cli_new_lark_app",
    "feishuAppSecret": "...",
    "feishuDomain": "lark",
    "defaultWorkingDirectory": "/home/me/project"
  }]
}
```

Single-bot environment mode uses `FEISHU_DOMAIN=lark`. A dedicated Wiki or
document service app uses `FEISHU_SERVICE_APP_ID`,
`FEISHU_SERVICE_APP_SECRET`, and `FEISHU_SERVICE_DOMAIN=lark`. When no
dedicated service credentials are set, the service reuses the first bot's
credentials and domain.

The installer also passes this value to `lark-cli config init --brand`, so a
new CLI configuration uses the same API tenant. If `lark-cli` is already
configured, the installer leaves that user-owned configuration untouched;
create or reinitialize the Lark CLI configuration with `--brand lark` before
using Lark Skills.

`~/.lark-cli/config.json` is one global user configuration; the Bridge's
per-bot domains do not switch it automatically. On a host with both Feishu and
Lark bots, whichever bot initializes `lark-cli` first supplies that global
brand. Manage separate tenant profiles manually if the installed CLI version
supports them, or reinitialize the global configuration with the required
`--brand` before using Skills against the other tenant.

## Do not reuse tenant-scoped IDs

Feishu and Lark issue identifiers inside a tenant. App IDs, open IDs, union
IDs, chat IDs, message IDs, Wiki space IDs, Wiki node tokens, document tokens,
and Drive file tokens from one tenant are not valid in another. Provision the
Lark app and conversations as new resources; do not copy Feishu IDs into the
Lark configuration or scheduled payloads.

## Start Wiki sync with fresh mappings

Wiki sync stores document and folder mappings in `sync-mapping.db` under
`WIKI_SYNC_STATE_DIR`. Those rows contain tenant-scoped Wiki node and document
IDs. For a Lark migration:

1. Set the Lark service credentials and `FEISHU_SERVICE_DOMAIN=lark`.
2. Select or create a Wiki space in the Lark tenant and use its new
   `WIKI_SPACE_ID`, or leave the value empty to find/create by name.
3. Point `WIKI_SYNC_STATE_DIR` to a new empty directory. Do not copy or reuse
   the Feishu `sync-mapping.db`.
4. Run the first sync only after the Lark service app has Wiki, Docx, and Drive
   permissions and access to the target space.

Keep the old Feishu mapping directory until the migration is verified; it is
the rollback record for the old tenant.

## Live provisioning still required

Code configuration alone cannot create tenant resources. Before a live Lark
test, an administrator must provide and publish the Lark chat app, approve its
scopes and event subscription, add it to fresh Lark chats, provision the
service app/space if Wiki sync is used, and update protected runtime
credentials and IDs. A controlled service restart is required only after those
runtime changes are made.
