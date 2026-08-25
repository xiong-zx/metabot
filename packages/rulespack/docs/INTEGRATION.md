# Thin audited-engine adapter integration contract

The later MetaBot adapter should remain a translator and transport binding. It
must not reimplement matching, precedence, rendering, budgeting, cache, or pack
digest logic.

## Turn sequence

1. A background/config event calls the applicable `RuleSourceAdapter` and
   `engine.refreshSources`. Do not scan Markdown or MetaMemory on every turn.
2. At the unified Codex/Claude turn boundary, construct one exact `ExecutionSubject`
   from authenticated runtime facts. Never accept bot/agent/worker/project/chat
   identity from Rule text or an untrusted prompt.
3. Call `engine.compile` once. Re-evaluate source freshness before cache lookup,
   then record telemetry and a `compiled` or `shadowed` receipt.
4. In `off`, inject nothing. In `shadow`, compare/observe but inject nothing.
   In `enforce`, place only `result.injectionText` in Codex's truthful pre-user
   input or Claude's system-prompt appendix. Do not put pack metadata into the model context.
5. A persistent engine session compares `packDigest` at a turn boundary. Reuse
   the session when unchanged; recycle/resume safely when changed. Never alter
   an in-flight turn.
6. For Agent Team, Worker, ARC, background, scheduled, restart, or peer work,
   construct the child subject and compile the child subset before dispatch.
   The child consumes the supplied pack; it does not search the dispatcher's
   sources.
7. Store `injected` and received-envelope `consumed` only after exact target
   input acceptance; store `rejected` on spawn/input/transport failure. Include
   truthful channel, subject fingerprint, digest, issuer/audience, and replay ID.

## Dispatch and cross-host delivery

Wrap a verified `CompiledRulesPack` in `RulesPackDispatchEnvelopeV1`. Before
consumption:

- authenticate the existing Agent Bus/peer capability or signature;
- enforce audience, issuer authorization, expiry, and one-time replay ID;
- call `validateDispatchEnvelope` and `verifyCompiledPack`;
- compare the expected locally constructed target, never a prompt-supplied one;
- overlay only host-local mandatory policy by compiling a new target-bound
  pack or a documented composite, never by editing the received rendered text;
- rebind every selected Rule to the full target fingerprint before storage;
- return a consumed-digest receipt only after target input acceptance.

The envelope fingerprint deliberately excludes authentication bytes so the
downstream transport can sign or capability-bind it. A remote host receives a
compiled pack. It must not read the dispatcher's MetaMemory namespace.

## Failure and degraded semantics

| Condition                                                         | Required behavior                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mode `off`                                                        | Continue with empty injection and `bypass-off` telemetry.                                                                                                                                                                                                           |
| Cache miss                                                        | Compile deterministically; the store re-runs the canonical compile against complete current input and atomically persists cache provenance plus an LKG link only for a nondegraded pack; report miss.                                                               |
| Optional advisory source unavailable                              | Use bounded stored generation when available; mark degraded/stale and report.                                                                                                                                                                                       |
| Expired optional temporary delivery                               | Replace only its current snapshot with an empty fresh tombstone; preserve immutable history, replay, audit, and receipts without degrading unrelated policy.                                                                                                          |
| No stored optional generation                                     | Continue without it; mark degraded/unavailable and report.                                                                                                                                                                                                          |
| Required source unavailable                                       | Raise `SOURCE_UNAVAILABLE`; adapter decides task-level fail/rollback policy.                                                                                                                                                                                        |
| Corrupt/unauthorized Rule, delimiter/credential risk, path escape | Fail closed; do not use LKG to bypass the guard.                                                                                                                                                                                                                    |
| Wrong subject/audience, expired/tampered pack                     | Fail closed with `TARGET_MISMATCH` or validation error; no injection.                                                                                                                                                                                               |
| Mandatory Rule/dependency/budget failure                          | Fail closed; never silently omit or truncate it.                                                                                                                                                                                                                    |
| Explicit transient `COMPILE_UNAVAILABLE`                          | Use bounded LKG only when the exact current cache key resolves through an intact authoritative compile record to digest-verified stored pack bytes, after complete current source and lifecycle-boundary validation and `RulesStore.isPackSafe`; mark degraded/LKG. |
| Any other compile/store/validation failure                        | Fail closed; LKG must not mask it.                                                                                                                                                                                                                                  |

Audit data is bounded and redacts content/secret-shaped fields. Receipts never
claim `injected` or `consumed` until the corresponding adapter action succeeds.

## Generation and invalidation rules

- A source generation changes only when its normalized effective snapshot
  changes. Revisions may be provider-native; generation and snapshot digest
  must remain deterministic.
- `replaceSourceSnapshot` atomically retains version history and replaces that
  source's current Rule pointers.
- A changed source invalidates cache entries indexed to that source. Other
  sources and unrelated cached keys remain intact. LKG links cascade from their
  authoritative cache records, so replacement/deletion makes the linked LKG
  unusable immediately.
- Cache reads always run revocation/expiry/current-digest checks. A revocation
  immediately invalidates persistent cache/LKG and makes stale in-memory hits
  fail safety validation.
- The deterministic compile/cache identity includes compiler version, effective
  mode, normalized budget, subject fingerprint, recomputed complete source
  snapshot digest, normalized source kind/ID/generation/revision/digest/
  required/health/rule-count state, and degradation reasons. Before persistence,
  the store checks that the complete Rule input is the current stored snapshot,
  independently recompiles it, and records compile-input and exact pack-bytes
  digests. Cache and LKG reads verify those records rather than trusting
  pack-declared identity fields or caller-recomputed public digests.
- Packs expire at the next Rule `validFrom` or `expiresAt` transition, including
  nonselected Rules, so an unchanged snapshot cannot hide newly applicable or
  newly inapplicable conflict/dependency participants. Before that boundary, a
  not-yet-valid Rule may be omitted by LKG only when `pack.expiresAt` is at or
  before its `validFrom`; at the boundary the pack is expired and fresh compile
  is required.

## Database migration and rollback

Use a RulesPack-owned database such as `rules-state.sqlite`; never reuse or
migrate MetaMemory, Agent Team, Worker, ARC, or live MetaBot databases. Schema
v3 adds authoritative compile provenance and cache-key-bound LKG links to the
standalone Rule versions/current pointers, revocations, source generations,
pack cache/source index, cache metadata, legacy LKG, audit, delivery receipts,
and feedback tables. Pre-v3 standalone cache/LKG rows lack provenance and are
intentionally not eligible for recovery.

Future migrations must be forward/additive, transactional, and preserve Rule
history. Before enabling a new adapter build, back up the standalone database
and record its schema/compiler versions. Rollback sequence:

1. set `RulesPack mode=off`;
2. stop injecting on new turns and recycle previously injected persistent
   sessions only at turn boundaries;
3. keep database/history/receipts in place (no destructive down migration);
4. roll back the adapter/code commit;
5. clear only recomputable cache/LKG if compiler compatibility requires it.

## Adapter work still required

- MetaBot `ExecuteApiTaskInput`/Codex and Claude executor hooks and exact injection order;
- persistent-session digest refresh and restart continuation;
- concrete config, RuleSet, AGENTS/native-file, structured command, and
  MetaMemory bindings;
- Agent Team/Agent Bus/Worker/ARC/scheduler schemas and persistence;
- authenticated capability/replay binding and iMac-to-Savio receipt path;
- diagnostics endpoint/command wiring and real admin/project-chat telemetry;
- authorized shadow/enforce use, rollback drill, deployment, and live E2E.

None of those actions is performed by this standalone repository.
