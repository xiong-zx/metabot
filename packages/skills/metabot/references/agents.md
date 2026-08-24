# Agent Registry And Inbox Relay

```bash
metabot agents list
metabot agents whoami
metabot agents talk <peer>[/<bot>] [<chatId>] "message" [--async] [--cards]
metabot agents talk-status <taskId>
metabot inbox register [--bot-name <name>]
metabot inbox poll [--chat <id>] [--once|--loop]
metabot inbox peek [--chat <id>]
```

When `chatId` is omitted, the CLI may derive a project-scoped conversation ID.
Use an explicit ID for a thread shared across hosts. Inbox polling is the relay
surface for CLI-only Agents without a resident bridge.

Inside a signed engine session, the same Bot may target another chat on its
resident Bridge and dispatch asynchronously through that Bridge. The command
forces target-chat cards and returns a task/card delivery receipt; the signed
source Bot and Chat are bound to status reads. Delegated task IDs are full
UUIDs, and status output is rejected when its source, target, time, result, or
lifecycle fields conflict. A missing local Bot never falls back to a same-named
peer on this signed path.
It never reads or falls back to
the Bridge administrator secret. CLI-only and remote targets retain the Core
inbox relay; a protected remote target remains fail-closed until its sender
Bridge can attach an authenticated RulesPack dispatch and explicit target grant.
`METABOT_ENGINE_BRIDGE_URL` is injected from the actual Bridge listener for this
capability path; it is separate from the peer-advertisement URL and is not a
user setting.
