# Agent Team Upstream-First Closure

Date: 2026-08-17

## Scope

This closure restores two behavior contracts lost during the upstream-first
migration and isolates one existing downstream governance capability:

- compact Agent Team cards;
- reliable scheduled and background delivery while the PM chat is busy;
- update-oriented activity cards that coalesce short bursts and reuse one
  message per chat;
- schedule management limited to an `admin`, `user`, or `pm` principal's
  signed bot and chat scope;
- exact Agent/role RuleSet targeting without silent broadcast;
- activity cards routed through the same instance-pinned PM bot as governed
  Agent execution.

No legacy Team Store, Worker Manager, Memory Core, or customized Agent Team UI
was restored.

## Classification

| Change | Classification | Owned root | Thin integration points |
| --- | --- | --- | --- |
| Compact Team cards | Upstreamable | `src/feishu/team-panel.ts` | v1/v2 card builders |
| Busy schedule retry | Upstreamable | `src/scheduler/busy-retry-policy.ts` | `TaskScheduler.fireTask()` |
| Deferred activity and card lifecycle | Upstreamable | `src/bridge/deferred-activity-delivery.ts` | per-chat `MessageBridge` enqueue, card-reference, and serialized update hooks |
| Scoped schedule management | Downstream-only W01 | `src/agent-teams/schedule-capability.ts` | HTTP capability gate, schedule routes, CLI forwarding |
| Exact RuleSet targeting | Downstream-only W01 | `src/agent-teams/governance-extension.ts` | Supervisor execution subject |
| Pinned activity routing | Downstream-only W01 | `src/agent-teams/governance-extension.ts` | Supervisor activity bot selection |

The upstreamable roots remain listed in `config/downstream-features.json`
only while downstream carries them ahead of upstream. Remove those temporary
manifest entries after upstream accepts equivalent commits.

## Behavior Contracts

### Compact cards

- show a shortened Team label and `working/total` count;
- show no more than two active-agent lines;
- collapse an all-idle Team to one line;
- preserve task counts, task ownership, and the stable card-chrome prefix used
  when a user replies to a MetaBot card.

### Busy-chat reliability

- scheduled work remains pending for a persisted 30-minute busy window;
- retries use exponential delays capped at five minutes;
- a Bridge restart resumes the original window instead of resetting it;
- recurring occurrences exhaust quietly, while a one-time task sends one
  failure notice;
- Agent Team and spontaneous activity share a deduplicated, 25-item bounded
  queue and deliver no later than the 30-minute cap.

### Activity-card lifecycle

- activity arriving in one 250 ms window is delivered as one combined body;
- subsequent activity within 30 minutes updates the existing card instead of
  creating another message;
- writes for one chat are serialized so activity arriving during the initial
  network send updates that message after it is created;
- a rejected or failed update falls back to a new card without losing the
  activity body.

### Scoped scheduling

- only `admin`, `user`, and `pm` execution capabilities may manage schedules;
- list/create/update/pause/resume/delete are limited to the signed `botName`
  and `chatId`;
- managers, agents, workers, invalid capabilities, and cross-scope IDs fail
  closed;
- the CLI never forwards the Bridge administrator secret from an engine
  session.

### RuleSet target truthfulness

- omitted targets apply to every Agent in the governed instance;
- `agent:<name>` and `role:<role>` match the exact execution subject;
- legacy unprefixed targets normalize to exact Agent names;
- wildcard or unknown target syntax is rejected, never silently broadcast;
- provenance records both total and selected rule counts.

### Instance-pinned activity routing

- governed member execution and activity cards use the same instance `pmBot`;
- an unavailable pinned bot is logged before the existing global fallback is
  used;
- unrelated global bots do not receive activity when the pinned bot exists.

## Validation

- stable-main focused Agent Team integration: 19 files, 231 tests;
- stable-main root and workspace test run: 1,550 passed, 1 expected skip;
- `origin/dev` combined Agent Team integration: 20 files, 260 tests;
- final activity-card targeted suite: 2 files, 60 tests;
- final `origin/dev` root and workspace test run: 1,585 passed, 1 expected skip;
- full build and release packaging passed;
- lint passed with no errors and six unrelated baseline warnings;
- release downstream-boundary gate and `git diff --check` passed;
- `upstream/main` remains an ancestor of the integration branch.

## Live Acceptance

The authorized current-chat E2E completed on runtime `816922a`:

- deploy request `agent-team-e2e-20260817-002` reached `healthy` for Bridge,
  Worker Runner, ARC, and Core;
- signed scheduling rejected a cross-chat create and listed only the signed
  bot/chat scope;
- governed Run `run-msxkbdu9-ngi7so` returned `TARGET-YES ROLE-YES` without
  the non-target `TARGET-NO`, with one task-bound Run and no duplicate;
- compact-card message `om_x100b6701643e30a1084ad822a0315e2`
  rendered a shortened Team label, `0/4 working`, and one all-idle line;
- pm holder `db196995` made schedule
  `62d505ac-8890-4845-b961-382aba848809` persist one busy retry before the
  same task completed with `SCHEDULE-FIRED`;
- deployed MessageBridge logged six bounded activity deferrals, and the same
  production `DeferredActivityDelivery` class delivered interactive card
  `om_x100b670114aa74a10870afb1fa6f01c` exactly once after busy cleared.

The E2E also found that Supervisor activity used the global bot instead of the
instance `pmBot`. Commit `0fe67ae` fixed that route. Protected deployment
`agent-team-at007-deploy-20260817-001` loaded runtime `8489160`; governed Run
`run-msxqzoo6-ht47qt` completed as `AT007-DEPLOYED-DONE` and every activity
delivery was logged with `bot: "pm"`.

That deployed check exposed AT-003: one completion created three activity
cards. Commit `c43aea4` added burst coalescing, message reuse, serialized
per-chat writes, and fallback delivery. Protected deployment
`agent-team-at003-deploy-20260817-001` reached `healthy` with Bridge, Worker
Runner, ARC, and Core all pinned to that worktree. In the current group:

- Run `run-msxrl7kp-e127nz` completed as `AT003-BURST-ONE`;
- Run `run-msxrmhvy-i324ov` completed as `AT003-UPDATE-TWO`;
- exactly one new card was sent,
  `om_x100b670c586024a1085c76c8ae497da`;
- the three later deliveries updated that same message ID, with no additional
  card creation;
- all Run execution and activity-card logs used the instance-pinned `pm` bot.

The temporary governed E2E instance and its generated Team were deleted after
the acceptance run. No Agent Team live gate remains.

## Rollback

Revert the focused feature commits or switch PM2 back to the prior tested
`8489160` worktree. No schema migration is required: scheduler fields are
optional JSON properties, while the activity queue and card-reference cache
are in-memory only. Existing Team, Task, Message, Run, Template, RuleSet, and
schedule records remain compatible.
