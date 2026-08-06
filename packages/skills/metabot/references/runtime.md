# Scheduling And Runtime Operations

Bridge-local commands exist only when listed by `metabot help`:

```bash
metabot schedule add <agent> <chatId> <delaySeconds> "<prompt>"
metabot schedule cron <agent> <chatId> "<cronExpr>" "<prompt>"
metabot update [--git|--package|--version <version>]
metabot restart
metabot restart --daemon <worker|arc> [--force]
metabot deploy-runtime --runtime <absolute-directory> [--force]
metabot status
metabot logs
metabot health
metabot bots
metabot peers
```

Schedules target Agent + Chat ID; the engine Session ID is diagnostic and may
change. Immutable release versions provide the package rollback surface.

`start`/`stop` cover Bridge, Worker Runner, and ARC. Plain `restart` remains
Bridge-only. Daemon restart and runtime deployment refuse active work unless
the operator passes `--force`; forced interruption can leave durable records
in `recovery_required`. Run `deploy-runtime` only from outside the MetaBot
process tree. Rolling back to a pre-daemon release also requires
`pm2 delete metabot-worker-runnerd metabot-arcd && pm2 save`.
