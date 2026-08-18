# MetaBot RulesPack adapter

Downstream-only Codex integration for the vendored `@metabot/rulespack`
engine. The package translates authenticated MetaBot runtime facts, manages
event-driven sources and host-local storage, binds authenticated dispatch and
replay checks, and exposes operator methods. It does not implement matching,
precedence, rendering, budgeting, or pack verification.

See `docs/features/rulespack.md` in the repository for configuration,
authority, flow, storage, migration, and rollback details.
