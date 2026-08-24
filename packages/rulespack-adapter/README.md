# MetaBot RulesPack adapter

Downstream-only Codex integration for the vendored `@metabot/rulespack`
engine. The package translates authenticated MetaBot runtime facts, manages
event-driven sources and host-local storage, binds authenticated dispatch and
replay checks, resolves exact configured `(bot, chatId)` project membership,
and exposes operator methods. It does not implement matching,
precedence, rendering, budgeting, or pack verification.

See `docs/features/rulespack.md` in the repository for configuration,
authority, flow, storage, migration, and rollback details.

The adapter also exports the shared multi-bot resolver used by the Bridge and
Worker Runner. It applies Codex-only defaults, materializes `{surface}` and
`{bot}` database paths, preserves required sources, and returns non-secret
adoption/opt-out state for diagnostics.

Dispatch issuer and allowlist entries are authenticated transport identities,
not bot templates. Core-backed peer delivery verifies the fixed configured
issuer against the Bridge credential's `/api/whoami` `botName`; explicit peer
secrets retain local-administrator-equivalent semantics.
