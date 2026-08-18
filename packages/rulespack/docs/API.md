# Stable engine API and contract

The v1 schema and `rulespack-compiler/1.0.0` define the adapter boundary.
Breaking selection, rendering, digest, or transport semantics require a new
compiler version. All ordering is explicit and locale-stable; array/set inputs
are normalized before hashing.

## Core models

- `RuleV1` / `RuleInputV1`: one approved atomic instruction, precomputed digest
  and token estimate, scope/binding, exact targets, authority, priority,
  conflict/dependency metadata, lifecycle, and source provenance.
- `ExecutionSubject`: one exact Codex execution identity: host, bot, roles,
  optional agent/worker/user/project/task/session, chat, tools, data classes,
  and output types.
- `SourceGeneration` / `SourceSnapshot`: one adapter's immutable structured
  generation and freshness record.
- `SelectedRule`, `RuleDecision`, `CompiledRulesPack`: immutable target-bound
  result plus every selection/rejection reason and concise rendered text.
- `DeliveryReceipt`, `RulesFeedback`, `AuditEvent`, `CompileTelemetry`: durable
  operator evidence without logging Rule bodies in audit events.
- `RulesPackDispatchEnvelopeV1`: generic target-bound transport contract. The
  later downstream adapter supplies authentication and replay enforcement.

## Deterministic compiler

`compileRules(request)` is a pure, synchronous, LLM-free compiler. The order
for conflict resolution and final rendering is:

1. authority: `platform`, `runtime`, `user-current`, `user-approved`,
   `project`, `advisory`;
2. within the highest authority represented in a conflict group, a
   non-overridable Rule is protected from same/lower-authority alternatives;
3. scope specificity: `task`, `chat`, `project`, `user`, `global`;
4. number of exact target/binding dimensions;
5. explicit integer priority;
6. numeric-aware version ordering;
7. stable Rule ID.

Authority and scope are separate axes. Exact exclude predicates are evaluated
before includes. Within one include/exclude object, every declared dimension
must match and each multi-valued dimension matches by exact intersection. No
wildcards, substring matches, inferred roles, or fuzzy identity are supported.

After matching, the compiler:

- verifies dependency availability and cycles;
- resolves each `conflictKey` to one winner;
- deduplicates normalized identical text;
- keeps dependency closures atomic;
- includes mandatory platform/runtime or explicitly mandatory Rules first;
- admits remaining whole Rules in deterministic precedence order;
- never truncates or LLM-summarizes a Rule;
- fails with `MANDATORY_BUDGET_EXCEEDED` if mandatory content cannot fit.

`explainRules(request)` returns the same pack plus a compact summary.
`subjectFingerprint(subject)` and `sourceSnapshotDigest(...)` are stable cache
inputs. `verifyCompiledPack(pack)` revalidates target fingerprint, Rule digests,
rendered bytes/counts, budget, expiry, pack ID, and the complete pack digest.
Compile/observation timestamps and source freshness deadlines remain telemetry
and are intentionally excluded from the digest, so an unchanged effective
subject/generation produces the same digest.

## Rendering and sanitization

`renderRules` emits only Rule metadata and concise approved text between
reserved `RULESPACK DATA v1` and per-Rule delimiters. The truthful delivery
channel is `user`, because the future Codex adapter must use the strongest
available pre-user position without claiming system/developer authority.

Validation rejects reserved delimiters, control/bidirectional override
characters, privileged-channel impersonation, authority-promotion phrases,
common prompt-override forms, and credential-like material. `platform` and
`runtime` authority require `source.trustedAuthority=true`; ordinary curated,
temporary, project, and MetaMemory adapters do not set it.
The CLI strips source-claimed trust from raw input and restores it only with an
explicit `--trusted-authority` operator flag for compiler-owned sources.

## Store and engine

`RulesStore` owns one isolated SQLite database. Important methods include:

- `upsertRule`, `replaceSourceSnapshot`, `revokeRule`, `listRules`;
- `putCachedPack`, `getCachedPack`, `invalidateSourceCache`, `clearCache`;
- `putLastKnownGood`, `getLastKnownGood`, `isPackSafe`;
- `recordAudit`, `recordReceipt`, `recordFeedback` and bounded list methods;
- `counts` and `listSourceGenerations`.

`RulesPackEngine` composes store and in-process LRU behavior:

- `refreshSources(adapters)` is the asynchronous ingestion path;
- `compile(...)` is the per-turn indexed/cache hot path;
- `setMode`, `invalidateSource`, `clearCache`, and `status` are operator hooks.

The cache key covers compiler version, subject fingerprint, source snapshot and
generations, compile budget, and mode. A hit is accepted only if every selected
Rule is still current, digest-identical, unrevoked, and unexpired.

## Source adapters

`RuleSourceAdapter` is the only required source interface. Included primitives:

- `configSource` and `rulesetSource` for approved structured configuration;
- `TrustedFileSource` for bounded structured JSON under a canonical trusted
  root, with realpath/symlink escape prevention and `nativeLoaded` suppression;
- `temporarySource` for authenticated structured session/chat/task Rules with
  mandatory expiry (never free-text inference);
- `MetaMemorySource` with an injected reader and explicit host-local path
  allowlist; the engine has no MetaMemory or host-path dependency;
- `curatedSource` for already-approved candidates only. Candidate generation
  and Rule Curator are outside this repository.

Examples in `examples/` are schema input, not active policy.
