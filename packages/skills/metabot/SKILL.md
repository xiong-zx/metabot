---
name: metabot
description: "Unified MetaBot CLI — central memory, skills hub, agent bus (talk to peer bots), and t5t (daily team status portal). Use when reading/writing shared memory, browsing/installing skills, listing or messaging peer bots, posting daily T5T entries, or coordinating cross-bot work."
---

## Quickstart

The `metabot` CLI is the single entry point to the metabot-core ecosystem. It wraps four surfaces:

```bash
metabot memory <cmd>   # shared knowledge / notes
metabot skills <cmd>   # skill registry                (alias: skill)
metabot agents <cmd>   # peer-bot address book
metabot inbox  <cmd>   # central inbox for CLI agents (CC / Codex with no bridge)
metabot teams  <cmd>   # local Agent Teams orchestration
metabot t5t    <cmd>   # daily team status portal
metabot help           # top-level help (also --help, -h, bare invocation)
```

`metabot` is the **single** CLI binary. Beyond the metabot-core surfaces above, it also handles bridge process control (`update`/`start`/`stop`/`restart`/`logs`/`status`) and a bridge daemon API (`bots`/`bot`/`talk`/`schedule`/`voice`/`stats`/`peers`/`metrics`/`health` — see the bridge-local section below). The legacy `mm`, `mh`, and per-bot `bot-skills` surfaces have been removed; `mb` is now a thin deprecation wrapper that forwards to `metabot`. Switch any script still calling them to the `metabot <subcommand>` form (see the migration table below).

Auth is automatic: `METABOT_CORE_TOKEN` (env) or `~/.metabot-core/token` (first line). Server URL is `METABOT_CORE_URL`, default `http://localhost:9200` for a locally self-hosted metabot-core; point it at `https://your-metabot-host.example.com` if you run metabot-core on a remote box behind your own reverse proxy.

**Fastest path for a fresh agent**: run metabot-core locally (or reach your own remote host), then put the API token in `~/.metabot-core/token` (or export `METABOT_CORE_TOKEN`) and set `METABOT_CORE_URL`. No SSO or corporate VPN is required for the personal edition — a single local API token is the only credential. Then `metabot agents whoami` should echo your identity.

## `metabot memory` — shared knowledge

Most-used:

```bash
metabot memory list [folder_id]                      # browse the tree
metabot memory search "<query>"                      # full-text search
metabot memory get <id|path>                         # read a doc (JSON metadata + content)
metabot memory create "<title>" ["<content>"] --share --tags a,b
metabot memory create "<title>" ["<html>"] --share --html --tags docs
metabot memory mkdir "<name>"                        # create a folder
metabot memory update <id> [content] [--title …] [--tags a,b,c] [--share|--no-share]
metabot memory share <id> [on|off]                   # toggle one doc's cross-bot visibility
metabot memory visibility [public|private]           # default shared flag for new docs
metabot memory health
```

(Replaces the former standalone `mm` CLI — same wire calls, same behavior, single binary.)

**Write target — `create` / `mkdir`.** Both accept an explicit `--path </absolute/path>`:

```bash
metabot memory create "Smoke note" "..." --path /users/<botName>/smoke-note
metabot memory mkdir "smoke-folder"   --path /users/<botName>/smoke-folder
```

When `--path` is given the server ACL-checks it and auto-creates any missing
ancestor folders. With **neither** `--path` nor `--folder` (nor a `parent_id`
for `mkdir`), the write **defaults into your own namespace** —
`/users/<botName>/<slug-of-title>` for `create`,
`/users/<botName>/<name>` for `mkdir` — resolved via `GET /api/whoami`. This
is the fix for the old member `403 forbidden`: members cannot write the root
namespace, so a bare `create`/`mkdir` previously failed. Admin tokens keep the
legacy root default. `--folder <id>` still targets an explicit existing folder
as before.

**Read visibility is document-level.** A document's cross-bot visibility is
controlled by its `shared` flag, not by the path. Use `--share` when creating
team-visible memory; use `--no-share` for private notes. Tags are for search
and discovery, not ACL, but they should still describe audience and topic:

```bash
metabot memory create "Runbook" "$CONTENT" --share --tags team,runbook
metabot memory create "Landing page" "$HTML" --share --html --tags metabot,tutorial
metabot memory update <doc_id> --share --tags metabot,public
metabot memory share <doc_id> on
```

**Per-bot default visibility — `memoryPublic`.** Bots can flip the default
`shared` value for new documents without admin intervention. `public` means
new docs default to `shared:true`; `private` means new docs default to
`shared:false`. Explicit `--share` / `--no-share` on create/update always wins.
Default for newly-registered bots is **public** (`memoryPublic: true`):

```bash
metabot memory visibility            # prints {state: "public" | "private"}
metabot memory visibility public     # new docs default shared:true
metabot memory visibility private    # new docs default shared:false
```

Same shape and auth model as `bots.json` `visible` for agent-bus discovery
("bot self-toggles, owner credential or admin only" — PATCH
`/api/agents/<botName>/memory-visibility`). It only changes the default
`shared` value for *new* documents; existing docs are unchanged until you run
`metabot memory share <doc_id> on|off` or `metabot memory update <doc_id>
--share|--no-share`. To pin the choice across bridge restarts, set
`memoryPublic: true|false` on the bot's entry in `bots.json` — the bridge
re-asserts the column on every bulk-register and overrides whatever was last
toggled via CLI. Omitting the field in bots.json leaves CLI toggles sticky.

## `metabot skills` — skill registry

```bash
metabot skills list
metabot skills get <name>
metabot skills publish <name> --from <dir>        # reads <dir>/SKILL.md
metabot skills install <name> [--to <dir>]        # default --to .claude/skills/<name>
metabot skills remove <name>
metabot skills health
```

**Install location landmine:** `metabot skills install <name>` defaults to `<cwd>/.claude/skills/<name>`. For a Claude-Code-wide install, pass `--to ~/.claude/skills/<name>`:

```bash
metabot skills install metabot --to ~/.claude/skills/metabot
```

(Replaces the former standalone `mh` CLI — same wire calls, same behavior, single binary.)

## `metabot agents` — peer-bot address book

The agent bus is the registry of all reachable MetaBot bots in the org. Bots self-register with their callable URL; peers discover them with zero config; the actual talk RPC stays bot-to-bot (P2P). **Visibility is the permission** — if a bot is in the visible registry, anyone with a metabot-core token can talk to it. Owner credentials decide which of their bots to expose via `bots.json` (`visible: true|false`); the registry no longer stores a per-bot `talkSecret`.

```bash
metabot agents list [--include-hidden]
metabot agents register --url <url> [--bot-name <name>] [--hidden]
metabot agents heartbeat [--bot-name <name>]
metabot agents whoami
metabot agents visible <botName>
metabot agents hide    <botName>
metabot agents talk <peer>[/<bot>] [<chatId>] "<message>"
```

**`list`** — returns the visible registry. `--include-hidden` requires an admin token; member tokens get 403.

**`register`** — typically called by the IM-bridge on boot for each `visible:true` bot in `bots.json`, not by a human. `--bot-name` lets one credential register many distinct bots; without it, the credential's own `botName` is used (legacy 1:1 mode). Anti-squat is enforced server-side — re-registering an existing name from a different credential returns `403 name_squat`. `--hidden` sets `visible=false` at registration.

**`heartbeat`** — IM-bridges call this every ~60s, batched across all owned bots via `{botNames:[...]}`. Without `--bot-name`, falls back to the legacy single-bot form (uses the credential's own `botName`). After ~180s (3× heartbeat) a row is treated as stale and filtered out of `list`. Stale rows are kept in storage for audit; the store sweeps anything older than 24h.

**`whoami`** — calls `GET /api/whoami` to echo `{botName, role, authSource, credentialId}` for the current token. Bridges use the same endpoint internally to verify an inbound cross-bridge talk caller.

**`visible` / `hide`** — ownership-gated. Only the credential that registered the bot (or an admin token) can toggle visibility.

**`talk`** is a thin convenience: it does `GET /api/agents` to resolve `<peer>` → `{url}`, then either (a) `POST <peerUrl>/api/talk` for resident bridges, or (b) `POST <core>/api/inbox/<botName>` for CLI-only peers whose registered URL is the literal string `inbox:` (see [CLI-only agents](#cli-only-agents-inbox--project-as-chatid) below). The peer bridge verifies the token by calling central `GET /api/whoami`; if it returns 200, the call is authorized. Use `<peer>/<bot>` to target a specific bot inside that peer; `<peer>` alone targets a bot of the same name on that peer.

**Default chatId — project-derived.** If you omit `<chatId>`, the CLI derives one from the current working directory: `proj:<basename>:<sha1(abs-path)[:8]>` (stable per absolute path, intentionally **not** cross-machine stable — see the inbox section). The derived id is echoed on stderr so you can tell when the default fired:

```bash
$ metabot agents talk alice/research-bot "ping"
→ using project-derived chatId: proj:metabot:1a2b3c4d
→ alice/research-bot @ proj:metabot:1a2b3c4d
```

Pass an explicit chatId when you want to share a thread across machines or with a non-CLI sender (Feishu, browser, etc.).

**Semantics:**
- **Asynchronous.** The target bot receives the message in its own chat/session and processes the turn there. Its reply lands in the target bot's chat (not as the return value of this command).
- **The talk RPC is P2P for resident bridges.** The registry is an address book only — for bridge peers, `metabot agents talk` shells out to the peer's `/api/talk` directly and metabot-core never proxies the message body. For CLI-only peers (`url: 'inbox:'`), the message is spooled centrally in metabot-core's `agent_inbox` table and drained by the target via `metabot inbox poll`.

```bash
# Resolve the registry, then deliver
metabot agents list
metabot agents talk alice/research-bot chat_BBB "What did last week's retention dashboard show?"
```

### CLI-only agents (`inbox:` + project-as-chatId)

Claude Code and Codex have no resident bridge, so they can't accept inbound `POST /api/talk`. To make them addressable on the agent bus anyway, they register with a literal `url: 'inbox:'` marker (no scheme, no host — just the string). Senders observe the marker and reroute through metabot-core's central inbox; the CLI agent drains the queue with `metabot inbox poll`.

**Project = chatId.** Without Feishu, there's no natural conversation id, so each project directory's absolute path is hashed into `proj:<basename>:<sha1>[:8]`. This is the default chatId for both `metabot agents talk` (when chatId is omitted) and `metabot inbox peek/poll/clear` (when `--chat` and `--all-chats` are both omitted). Two checkouts of the same repo at different paths or on different machines are deliberately treated as **different** chats — pass an explicit `--chat` if you want to merge them.

```bash
metabot inbox project-id   # echo the cwd-derived chatId without doing anything else
```

End-to-end registration:

```bash
# On machine A (the CC/Codex user) — register once per machine
metabot inbox register                     # bot name defaults to cli:<ownerName>@<hostname>
metabot inbox poll --loop                  # block forever, draining as messages arrive

# On machine B (any sender with a metabot-core token)
metabot agents talk cli:flood@laptop "follow-up on the deploy"
# stderr: → using project-derived chatId: proj:<project>:<hash>
# A's `inbox poll` prints one JSON line per delivered message
```

## `metabot inbox` — central inbox for CLI-only agents

A small spool kept inside metabot-core (table `agent_inbox`) so CC/Codex peers — who can't accept inbound HTTP — can still receive `metabot agents talk` messages. Bots register with `url: 'inbox:'` (see the [CLI-only agents](#cli-only-agents-inbox--project-as-chatid) section above); senders observe the marker and reroute through `POST /api/inbox/<botName>`; the target drains the queue with `poll`. Each project directory is its own chatId by default.

```bash
metabot inbox register [--bot-name <name>]
metabot inbox project-id
metabot inbox peek    [--chat <id>] [--all-chats] [--limit 20]
metabot inbox poll    [--chat <id>] [--wait 30] [--once|--loop]
metabot inbox clear   [--chat <id>] [--all-chats]
```

**`register`** — registers an inbox-only agent on the bus. Default `--bot-name` is `cli:<ownerName>@<hostname>` (ownerName from `GET /api/whoami`, hostname from `os.hostname().split('.')[0]`). The registration uses `url: 'inbox:'` and `visible: true`. Re-running it from the same credential is idempotent; a different credential trying to claim the same name gets `403 name_squat` like any other agent registration.

**`project-id`** — print the cwd-derived chatId and exit. Useful for sanity checks and for copy-pasting into an explicit `--chat` on a remote sender.

**`peek`** — show queued messages without popping them. Without `--chat` or `--all-chats`, filters to the cwd-derived chatId and prints a stderr notice (`→ using project-derived chatId: …`). `--limit` defaults to 20 and is hard-capped at 200.

**`poll`** — atomically pop the oldest queued message, long-polling up to `--wait` seconds. `--wait` defaults to 30 and is hard-capped at 60 (proxy idle limits). `--once` (default) returns after the first message or timeout; `--loop` keeps the call open forever and prints one JSON line per delivered message — the canonical mode for "open a terminal on machine A and leave it running". On `--once` timeout, prints a marker line `{"message":null,"waitedMs":<n>}` so pipelines can distinguish empty-poll from error. SIGINT/SIGTERM exits cleanly in `--loop` mode.

```json
{"id":"…","targetBot":"cli:flood@laptop","chatId":"proj:metabot:1a2b3c4d",
 "fromBot":"alice","fromOwner":"alice@example.com","content":"ping","enqueuedAt":"…"}
```

**`clear`** — delete queued messages. Defaults to the cwd chatId; `--all-chats` wipes every chat for the bot. Use this when a stale CLI session left messages behind that no longer make sense.

**Auth.** All inbox routes are Bearer-only (web identity is excluded by the same structural fork that protects `/api/t5t/cli/*`). `peek` / `poll` / `clear` require **owner** of the target bot (`cred.ownerName === bot.ownerName`, or admin); `enqueue` (i.e. `POST /api/inbox/<botName>` triggered by `metabot agents talk`) only requires a valid Bearer — sending is open, draining is gated.

**Anti-spoof.** The server stamps `fromBot`, `fromOwner`, `fromCredentialId` from the authenticated credential on every enqueue; any matching fields in the request body are ignored. The receiver can trust those three fields without further verification.

**Storage.** SQLite table `agent_inbox(id, target_bot, chat_id, from_bot, from_owner, from_credential_id, content, enqueued_at)` with index `(target_bot, chat_id, enqueued_at)`. No TTL — use `clear` or `metabot inbox count` (if added) to manage size. The table lives in the same `central.db` as `agents`, `memory_*`, and `t5t_*`.

## `metabot teams` — local Agent Teams

Agent Teams live in the local bridge (`/api/agent-teams/*`) and are optimized
for Codex-first delegation. New CLI-spawned teammates default to `codex`; pass
`--engine claude|kimi` only for explicit exceptions.

Lead path:

```bash
metabot teams create <team> --description "..."
metabot teams agents spawn <team> <agent> --role "runtime" --prompt "Own runtime work."
metabot teams dispatch <team> <agent> "Fix update package" --description "Self-contained scope." --plain
metabot teams status <team> --summary
metabot teams runs list <team>
```

`dispatch` is the smooth path: it creates a task, assigns it to the agent, and
sends the wake-up message in one command.

To parallelize independent verification, dispatch multiple pending tasks to the
same reviewer/verifier. The supervisor starts one run per ready task, up to
`METABOT_AGENT_TEAM_MAX_PARALLEL_PER_AGENT` concurrent runs per agent
(default: `4`), using isolated run-scoped chats for parallel same-agent work.

Teammate path:

```bash
metabot teams next <team> <agent> --read
metabot teams status <team> --summary
metabot teams tasks claim <team> <taskId> <agent>
metabot teams tasks done <team> <taskId> "result"
metabot teams tasks block <team> <taskId> "blocked reason" --blocked-by <id,id>
metabot teams send <team> lead "Completed task <taskId>: ..."
```

For repeated local teammate use, set `METABOT_TEAM_AGENT=<agent>` and omit the
owner argument in `tasks claim`.

Add `--summary` or `--plain` to `status`, `next`, `inbox`, `tasks list`,
`runs list`, `dispatch`, and `watch` for concise text output. Omit it when you
need the default JSON for scripts.

## `metabot t5t` — daily team status portal

T5T (天天天天天 — daily team status) is the team's append-only project tracker: each member pushes a daily entry, evaluators score evaluator-columns, leaders set goals and surface bottlenecks. All state is append-only docs in central memory; there are no updates or deletes — latest-doc-wins per `(project, type)` at read time.

```bash
metabot t5t board                              # full board (projects + recent + anomalies)
metabot t5t status                             # lightweight: projects + anomalies, no entries
metabot t5t whoami                             # echo caller's identity
metabot t5t projects [list|show <slug>]        # list or detail-view a project
metabot t5t push <project> <YYYY-MM-DD> "<item1>" ["<item2>" ...]
                                               # append a daily entry
metabot t5t feedback <entryDocId> "<comment>" [--mentions @a,@b]
                                               # reply on an entry
metabot t5t goal <project> "<text>"            # owner-only
metabot t5t evaluator <project> add|remove <email>
                                               # owner-only
metabot t5t bottleneck <project> "<text>"      # owner-only ; pass --clear to remove
metabot t5t wip <project> <evaluatorId> "<title>"
                                               # owner-only
metabot t5t kill <project>                     # owner-only ; soft-kill (append-only status=killed)
metabot t5t reopen <project>                   # owner-only ; reopen by appending status=unknown
metabot t5t delete <smoke-project>             # owner-only ; hard-delete smoke* test projects
metabot t5t top5 <project> add "<text>"        # owner-only ; add a Top-5 todo item
metabot t5t top5 <project> done|reopen|remove <itemId>
                                               # owner-only ; flip status of an existing item
metabot t5t top5 <project> list                # show the current Top-5 items
```

**Routes.** Every subcommand calls `/api/t5t/cli/*` (Bearer-only; web identity is excluded by the server). See `packages/server/src/t5t/t5t-routes.ts` for the exact shapes.

**Auth.** Uses the same `METABOT_CORE_TOKEN` env / `~/.metabot-core/token` file as `metabot memory` and `metabot agents`. No separate `~/.t5t/credentials` (the Python `t5t` CLI's auth file) is read or honored.

**Owner-auth.** `goal` / `evaluator` / `bottleneck` / `wip` / `kill` / `top5` are gated by project ownership: only the project's `leaderEmail` or an email listed in `allowedUsers` (admin tokens always pass). The server's deny-by-default contract means a project with *empty* `leaderEmail` AND *empty* `allowedUsers` rejects all writes — even from the project's original author. If you hit `owner_required` on a project you created, the leader was never seeded — fix via an admin token or by `push`ing the first entry under that slug (push auto-creates the project with the caller as leader).

**Auto-creation on push.** `metabot t5t push <new-slug> ...` creates the project with `leaderEmail = <your botName/email>`. The other write paths (`goal/evaluator/bottleneck/wip`) require the project to already exist; they 404 otherwise.

**Anomalies.** `board` and `status` include an `anomalies[]` array — each entry has a `reason` (`no_owner` / `stale` / `kill_red` / `no_goal` / `stale_bottleneck`). These are derived by the server from the latest docs at read time; no separate maintenance call needed.

**Migration from an older standalone `t5t` CLI**, if you ever used one:

| Old | New |
|---|---|
| `t5t push <slug> <date> "<item>"` | `metabot t5t push <slug> <date> "<item>"` |
| `t5t board` / `t5t projects` | `metabot t5t board` / `metabot t5t projects list` |
| `t5t goal <slug> "<text>"` | `metabot t5t goal <slug> "<text>"` |
| `t5t feedback <entry> "<comment>"` | `metabot t5t feedback <entryDocId> "<comment>"` |
| `~/.t5t/credentials` | discarded — use `~/.metabot-core/token` or `METABOT_CORE_TOKEN` |
| a hardcoded t5t host | `METABOT_CORE_URL` (default `http://localhost:9200`) |

The t5t portal is now just the t5t tab of your metabot-core instance — only `metabot t5t` is needed.

## `metabot` bridge-local — local bridge daemon API

Separate from the metabot-core surfaces above, `metabot` also curls the **local
bridge daemon** at `localhost:9100` (auth from `API_PORT` / `API_SECRET` in the
bridge `.env`). These commands act on the bot process running on this host:

```bash
metabot bots                              # list all bots (local + peer)
metabot bot <name>                        # get bot details
metabot talk [peer/]<bot> <chatId> <msg>  # talk to a bot via the bridge /api/talk
metabot teams ...                          # local Agent Teams
metabot schedule list|add|cron|pause|resume|cancel …   # task scheduler
metabot peers                             # list peers and status
metabot stats                             # cost & usage statistics
metabot metrics                           # Prometheus metrics
metabot voice call|transcript|list|config|tts …       # RTC voice call + TTS
metabot health                            # health check
```

**`talk` — two distinct paths.** `metabot talk` (here) hits the **bridge**
`/api/talk` on `localhost:9100` for local + peer-federated routing. `metabot
agents talk` (above) is the **central-registry** P2P path that resolves a peer
via the metabot-core agent bus. They are not aliases — pick by which registry
you want.

The per-bot bridge-local Skill Hub (`metabot bot-skills`) has been retired —
all skill publishing/installing now goes through the central `metabot skills`
surface above.

## Env vars

| Var | Purpose |
|---|---|
| `METABOT_CORE_URL` | Memory + skills + agents base URL. Default `http://localhost:9200` (locally self-hosted metabot-core); set to your own remote host if running it elsewhere. |
| `METABOT_CORE_TOKEN` | Bearer token for member or admin access. If unset, the CLI reads the first line of `~/.metabot-core/token`. |
| `METABOT_CORE_AGENT_BUS_URL` | Optional override for the agent-registry base URL when it diverges from `METABOT_CORE_URL` (e.g. a staging core). Falls back to `METABOT_CORE_URL`. |

## Migration from `mm` / `mh` / `mb`

The legacy `mm`, `mh`, and `mb` bins have all been removed. Install and
`metabot update` actively delete any leftover binaries from `~/.local/bin/`,
so old scripts will now hit `command not found`. Update every call site to
the unified form:

| Old | New (canonical) |
|---|---|
| `mm <cmd>` | `metabot memory <cmd>` |
| `mh <cmd>` | `metabot skills <cmd>` |
| `mb skills <cmd>` (was → `bot-skills`) | `metabot skills <cmd>` (central Skill Hub) |
| `mb talk <bot> <chatId> "<msg>"` | `metabot talk <bot> <chatId> "<msg>"` (bridge `/api/talk`) |
| `mb bots / schedule / voice / stats / peers / metrics / health` | `metabot <same subcommand>` |
| (n/a) | `metabot agents talk <peer>[/<bot>] <chatId> "<msg>"` (central-registry P2P variant) |
| (n/a) | `metabot agents list / register / heartbeat / visible / hide` (new in the agent-bus batch) |
| (n/a) | `metabot t5t <cmd>` (new in T5T MR5) |

The wire calls are identical — only the executable name changed. If
`command -v mm`, `mh`, or `mb` still resolves on your machine, run a fresh
`metabot update` (or `install.sh`) to scrub the stragglers.

The standalone `metamemory` and `skill-hub` skill bundles were never published in this fresh metabot-core arch; the unified `metabot` skill is the single skill bundle for the whole CLI surface.
