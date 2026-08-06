# Scheduling And Runtime Operations

Bridge-local commands exist only when listed by `metabot help`:

```bash
metabot schedule add <agent> <chatId> <delaySeconds> "<prompt>"
metabot schedule cron <agent> <chatId> "<cronExpr>" "<prompt>"
metabot update [--git|--package|--version <version>]
metabot restart [--request-id ID] [--bot NAME --chat ID] [--resume|--no-resume] [--wait] [--json]
metabot restart --daemon <worker|arc> [--force]
metabot deploy-runtime --runtime <absolute-directory> [--request-id ID] [--wait|--no-wait] [--force] [--json]
metabot status
metabot logs
metabot health
metabot bots
metabot peers
```

Schedules target Agent + Chat ID; the engine Session ID is diagnostic and may
change. Immutable release versions provide the package rollback surface.

`start`/`stop` cover Bridge, Worker Runner, and ARC. Plain `restart` remains
Bridge-only and changes its registered PM2 process in place. A stable request
ID deduplicates retries. The new Bridge saves PM2 only after startup health and
the pinned cwd, script, interpreter, arguments, and secret-safe SHA-256
environment fingerprints all match. It then
queues one continuation for normal user/PM chats when `--resume` is enabled;
the continuation must be atomically persisted before its timer is armed, and a
write failure retains the restart breadcrumb for startup replay.
Team and Worker/ARC internal recovery stays with their durable owners.
`deploy-runtime` prevalidates and switches the three Bridge-runtime apps
without deleting PM2 registrations, rolling back changed apps on failure. It
also switches a separate local Core only when PM2 proves the current checkout
owns it; external Core stays untouched. Uninstall uses the same ownership
guard. Daemon restart and runtime deployment refuse active work unless
the operator passes `--force`; forced interruption can leave durable records
in `recovery_required`. Run `deploy-runtime` only from outside the MetaBot
process tree. The command refuses to proceed when the live Bridge PID or caller
ancestry cannot be verified. Rolling back to a pre-daemon release also requires
`pm2 delete metabot-worker-runnerd metabot-arcd && pm2 save`.

Run an online package update only from SSH or another verified external
controller. It is rejected before download from inside the Bridge tree and
uses the request-ID-backed no-delete deployment path; initial/offline install
may create missing registrations but does not delete existing ones.
