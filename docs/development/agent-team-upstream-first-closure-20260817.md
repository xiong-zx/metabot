# Agent Team Upstream-First Closure

Date: 2026-08-17

## Scope

This closure restores two behavior contracts lost during the upstream-first
migration and isolates one existing downstream governance capability:

- compact Agent Team cards;
- reliable scheduled and background delivery while the PM chat is busy;
- schedule management limited to an `admin`, `user`, or `pm` principal's
  signed bot and chat scope.

No legacy Team Store, Worker Manager, Memory Core, or customized Agent Team UI
was restored.

## Classification

| Change | Classification | Owned root | Thin integration points |
| --- | --- | --- | --- |
| Compact Team cards | Upstreamable | `src/feishu/team-panel.ts` | v1/v2 card builders |
| Busy schedule retry | Upstreamable | `src/scheduler/busy-retry-policy.ts` | `TaskScheduler.fireTask()` |
| Deferred activity delivery | Upstreamable | `src/bridge/deferred-activity-delivery.ts` | `MessageBridge` enqueue/deliver hooks |
| Scoped schedule management | Downstream-only W01 | `src/agent-teams/schedule-capability.ts` | HTTP capability gate, schedule routes, CLI forwarding |

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

### Scoped scheduling

- only `admin`, `user`, and `pm` execution capabilities may manage schedules;
- list/create/update/pause/resume/delete are limited to the signed `botName`
  and `chatId`;
- managers, agents, workers, invalid capabilities, and cross-scope IDs fail
  closed;
- the CLI never forwards the Bridge administrator secret from an engine
  session.

## Validation

- focused Agent Team integration: 18 files, 227 tests;
- complete root and workspace test run: 1,546 passed, 1 expected skip;
- full build and release packaging passed;
- lint passed with no errors and six unrelated baseline warnings;
- release downstream-boundary gate and `git diff --check` passed;
- `upstream/main` remains an ancestor of the integration branch.

## Remaining Live Gate

Code integration and runtime deployment are separate decisions. Before these
items return to done, an explicitly authorized staging or test-chat run must
hold a foreground PM turn while triggering both a scheduled task and Agent
Team completion activity. Acceptance requires delayed, exactly-once delivery,
compact v1/v2 cards, no duplicate taskless Run, and no cross-chat schedule
visibility. Promotion, runtime switching, and restart require separate user
authorization.

## Rollback

Revert the four focused feature commits or their integration merges. No schema
migration is required: the scheduler fields are optional JSON properties, and
the activity queue is in-memory only. Existing Team, Task, Message, Run,
Template, RuleSet, and schedule records remain compatible.
