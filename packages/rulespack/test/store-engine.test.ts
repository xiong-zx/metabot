import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { RulesPackEngine } from '../src/engine.js';
import {
  compileIdentityDigest,
  compileRules,
  compiledPackIdentityDigest,
  recomputePackDigest,
  sourceSnapshotDigest,
  verifyCompiledPack,
} from '../src/compiler.js';
import { configSource } from '../src/sources.js';
import { RulesPackError } from '../src/errors.js';
import type { RuleSourceAdapter } from '../src/sources.js';
import { RulesStore } from '../src/store.js';
import { makeRule, NOW, sourceGeneration, subject } from './fixtures.js';

test('SQLite persists normalized Rules, generations, audit, receipts, feedback, cache, and LKG', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rulespack-store-'));
  const filename = join(directory, 'state.sqlite');
  const rule = makeRule({ id: 'persisted', text: 'Persist this rule.' });
  const source = sourceGeneration('gen-1', [rule]);
  let store = new RulesStore(filename);
  store.replaceSourceSnapshot({ source, rules: [rule] });
  const engine = new RulesPackEngine({ store, mode: 'enforce', cacheTtlMs: 60_000, lastKnownGoodTtlMs: 60_000 });
  const result = engine.compile({ subject, now: NOW });
  store.recordReceipt({
    receiptId: 'receipt-1',
    packDigest: result.pack.packDigest,
    subjectFingerprint: result.pack.subjectFingerprint,
    target: subject,
    status: 'consumed',
    channel: 'user',
    occurredAt: NOW,
  });
  store.recordFeedback({
    feedbackId: 'feedback-1',
    packDigest: result.pack.packDigest,
    kind: 'helpful',
    message: 'The intended Rule arrived.',
    createdAt: NOW,
  });
  store.close();

  store = new RulesStore(filename);
  assert.equal(store.getRule('persisted')?.digest, rule.digest);
  assert.equal(store.listSourceGenerations()[0]?.generation, 'gen-1');
  assert.equal(store.listReceipts(result.pack.packDigest)[0]?.receiptId, 'receipt-1');
  assert.equal(store.listFeedback(result.pack.packDigest)[0]?.feedbackId, 'feedback-1');
  assert.equal(store.counts().persistentCacheEntries, 1);
  const cacheKey = compiledPackIdentityDigest(result.pack);
  assert.equal(store.getCachedPack(cacheKey, NOW)?.packDigest, result.pack.packDigest);
  assert.equal(store.getLastKnownGood(cacheKey, NOW)?.packDigest, result.pack.packDigest);
  store.close();
});

test('cache and LKG fail closed when compile provenance is missing or stored pack bytes are tampered', () => {
  const missingStore = new RulesStore(':memory:');
  const missingRule = makeRule({ id: 'missing-provenance', text: 'Require persisted provenance.' });
  missingStore.replaceSourceSnapshot({
    source: sourceGeneration('gen-1', [missingRule]),
    rules: [missingRule],
  });
  const missing = new RulesPackEngine({ store: missingStore, mode: 'enforce' });
  const missingResult = missing.compile({ subject, now: NOW });
  const missingCacheKey = compiledPackIdentityDigest(missingResult.pack);
  missingStore.extensionTransaction((database) => {
    database.prepare('DELETE FROM authoritative_compiles WHERE cache_key = ?').run(missingCacheKey);
  });
  assert.equal(missingStore.getCachedPack(missingCacheKey, NOW), undefined);
  assert.equal(missingStore.getLastKnownGood(missingCacheKey, NOW), undefined);
  missingStore.close();

  const tamperedStore = new RulesStore(':memory:');
  const tamperedRule = makeRule({ id: 'tampered-bytes', text: 'Require exact stored bytes.' });
  tamperedStore.replaceSourceSnapshot({
    source: sourceGeneration('gen-1', [tamperedRule]),
    rules: [tamperedRule],
  });
  const tamperedResult = new RulesPackEngine({ store: tamperedStore, mode: 'enforce' }).compile({
    subject,
    now: NOW,
  });
  const tamperedCacheKey = compiledPackIdentityDigest(tamperedResult.pack);
  tamperedStore.extensionTransaction((database) => {
    database.prepare("UPDATE pack_cache SET pack_json = pack_json || ' ' WHERE cache_key = ?").run(tamperedCacheKey);
  });
  assert.equal(tamperedStore.getLastKnownGood(tamperedCacheKey, NOW), undefined);
  assert.equal(tamperedStore.getCachedPack(tamperedCacheKey, NOW), undefined);
  tamperedStore.close();
});

test('cache hits, source generation invalidation, and revocation-first safety work', () => {
  const store = new RulesStore(':memory:');
  const original = makeRule({ id: 'cached', text: 'Original cached rule.' });
  store.replaceSourceSnapshot({ source: sourceGeneration('gen-1', [original]), rules: [original] });
  const engine = new RulesPackEngine({ store, mode: 'enforce' });
  const first = engine.compile({ subject, now: NOW });
  const second = engine.compile({ subject, now: NOW });
  assert.equal(first.telemetry.cache, 'miss');
  assert.equal(second.telemetry.cache, 'hit-memory');

  const changed = makeRule({ id: 'cached', text: 'Changed generation rule.', version: '2' });
  store.replaceSourceSnapshot({ source: sourceGeneration('gen-2', [changed]), rules: [changed] });
  engine.invalidateSource('test-config');
  const third = engine.compile({ subject, now: NOW });
  assert.equal(third.telemetry.cache, 'miss');
  assert.notEqual(third.pack.packDigest, first.pack.packDigest);

  store.revokeRule('cached', 'user disabled it', '2026-08-18T06:00:01.000Z');
  const afterRevoke = engine.compile({ subject, now: '2026-08-18T06:00:02.000Z' });
  assert.equal(afterRevoke.pack.rules.length, 0);
  assert.equal(afterRevoke.pack.decisions.find((item) => item.ruleId === 'cached')?.disposition, 'revoked');
  store.close();
});

test('corrupt current Rule state never activates LKG and never resurrects revocation', () => {
  const store = new RulesStore(':memory:');
  const original = makeRule({ id: 'lkg', text: 'Known good rule.' });
  store.replaceSourceSnapshot({ source: sourceGeneration('gen-1', [original]), rules: [original] });
  const engine = new RulesPackEngine({ store, mode: 'enforce', lastKnownGoodTtlMs: 60_000 });
  const first = engine.compile({ subject, now: NOW });
  const corrupt = { ...original, digest: 'sha256:corrupt' };
  assert.throws(
    () =>
      engine.compile({
        subject,
        now: '2026-08-18T06:00:01.000Z',
        sourceState: {
          rules: [corrupt],
          generations: [sourceGeneration('corrupt-gen', [original])],
          degradationReasons: ['test source corruption'],
          usedLastKnownGood: false,
        },
      }),
    (error: unknown) => error instanceof RulesPackError && error.code === 'VALIDATION_ERROR',
  );

  store.revokeRule('lkg', 'revoked before retry', '2026-08-18T06:00:02.000Z');
  assert.equal(store.getLastKnownGood(compiledPackIdentityDigest(first.pack), '2026-08-18T06:00:03.000Z'), undefined);
  store.close();
});

test('LKG fallback is limited to an explicit transient compiler failure after current safety validation', () => {
  const store = new RulesStore(':memory:');
  const current = makeRule({ id: 'transient-lkg', text: 'Known safe Rule.' });
  store.replaceSourceSnapshot({ source: sourceGeneration('gen-1', [current]), rules: [current] });
  const first = new RulesPackEngine({
    store,
    mode: 'enforce',
    cacheTtlMs: 500,
    lastKnownGoodTtlMs: 60_000,
  }).compile({ subject, now: NOW });
  const transient = new RulesPackEngine({
    store,
    mode: 'enforce',
    lastKnownGoodTtlMs: 60_000,
    compiler: () => {
      throw new RulesPackError('COMPILE_UNAVAILABLE', 'temporary compiler resource unavailable');
    },
  });
  const fallback = transient.compile({
    subject,
    now: '2026-08-18T06:00:01.000Z',
    sourceState: {
      rules: [current],
      generations: [sourceGeneration('gen-1', [current])],
      degradationReasons: [],
      usedLastKnownGood: false,
    },
  });
  assert.deepEqual(
    fallback.pack.rules.map((rule) => rule.id),
    first.pack.rules.map((rule) => rule.id),
  );
  assert.equal(fallback.pack.lastKnownGood, true);
  assert.equal(fallback.telemetry.usedLastKnownGood, true);
  assert.equal(verifyCompiledPack(fallback.pack, '2026-08-18T06:00:01.000Z'), fallback.pack);
  store.close();
});

test('LKG rejects a changed generation that adds an applicable mandatory Rule', () => {
  const store = new RulesStore(':memory:');
  const baseline = makeRule({ id: 'baseline', text: 'Keep the baseline Rule.' });
  store.replaceSourceSnapshot({ source: sourceGeneration('gen-1', [baseline]), rules: [baseline] });
  new RulesPackEngine({ store, mode: 'enforce', lastKnownGoodTtlMs: 60_000 }).compile({ subject, now: NOW });

  const mandatory = makeRule({
    id: 'new-mandatory',
    text: 'New mandatory current policy.',
    mandatory: true,
    overridable: false,
    priority: 100,
  });
  store.replaceSourceSnapshot({
    source: sourceGeneration('gen-2', [baseline, mandatory]),
    rules: [baseline, mandatory],
  });
  const transient = new RulesPackEngine({
    store,
    mode: 'enforce',
    lastKnownGoodTtlMs: 60_000,
    compiler: () => {
      throw new RulesPackError('COMPILE_UNAVAILABLE', 'temporary compiler outage');
    },
  });
  assert.throws(
    () => transient.compile({ subject, now: '2026-08-18T06:00:01.000Z' }),
    (error: unknown) => error instanceof RulesPackError && error.code === 'COMPILE_UNAVAILABLE',
  );
  store.close();
});

test('retagging an old pack cannot forge engine compile provenance or restore invalidated LKG', () => {
  const store = new RulesStore(':memory:');
  const baseline = makeRule({ id: 'retag-baseline', text: 'Original selected Rule.' });
  const generationOne = sourceGeneration('gen-1', [baseline]);
  store.replaceSourceSnapshot({ source: generationOne, rules: [baseline] });
  const original = new RulesPackEngine({
    store,
    mode: 'enforce',
    cacheTtlMs: 500,
    lastKnownGoodTtlMs: 60_000,
  }).compile({ subject, now: NOW });
  const originalCacheKey = compiledPackIdentityDigest(original.pack);
  assert.ok(store.getLastKnownGood(originalCacheKey, NOW));

  const mandatory = makeRule({
    id: 'retag-mandatory',
    text: 'New mandatory Rule must not be omitted.',
    mandatory: true,
    overridable: false,
    priority: 100,
  });
  const generationTwo = sourceGeneration('gen-2', [baseline, mandatory]);
  store.replaceSourceSnapshot({ source: generationTwo, rules: [baseline, mandatory] });
  assert.equal(store.getCachedPack(originalCacheKey, '2026-08-18T06:00:00.100Z'), undefined);
  assert.equal(store.getLastKnownGood(originalCacheKey, '2026-08-18T06:00:00.100Z'), undefined);

  const currentRequest = {
    subject,
    rules: [baseline, mandatory],
    sourceGenerations: [generationTwo],
    budget: original.pack.budget,
    mode: 'enforce' as const,
    now: NOW,
    degradationReasons: [],
  };
  const currentCacheKey = compileIdentityDigest(currentRequest);
  const retagged = recomputePackDigest({
    ...original.pack,
    sourceGenerations: [generationTwo],
    sourceSnapshotDigest: sourceSnapshotDigest({ sourceGenerations: [generationTwo] }),
  });
  assert.equal(compiledPackIdentityDigest(retagged), currentCacheKey);
  assert.deepEqual(
    retagged.rules.map((rule) => rule.id),
    ['retag-baseline'],
  );
  assert.throws(
    () =>
      store.recordEngineCompile(
        currentCacheKey,
        currentRequest,
        retagged,
        '2026-08-18T06:00:30.000Z',
        '2026-08-18T06:01:00.000Z',
      ),
    (error: unknown) => error instanceof RulesPackError && error.code === 'STORE_ERROR',
  );
  assert.throws(
    () =>
      store.recordEngineCompile(
        currentCacheKey,
        { ...currentRequest, rules: [baseline] },
        retagged,
        '2026-08-18T06:00:30.000Z',
        '2026-08-18T06:01:00.000Z',
      ),
    (error: unknown) => error instanceof RulesPackError && error.code === 'STORE_ERROR',
  );
  const legacyStoreApi = store as unknown as Record<string, unknown>;
  assert.equal(legacyStoreApi.putCachedPack, undefined);
  assert.equal(legacyStoreApi.putLastKnownGood, undefined);
  assert.equal(store.getLastKnownGood(currentCacheKey, NOW), undefined);

  const transient = new RulesPackEngine({
    store,
    mode: 'enforce',
    compiler: () => {
      throw new RulesPackError('COMPILE_UNAVAILABLE', 'temporary compiler outage');
    },
  });
  assert.throws(
    () => transient.compile({ subject, now: '2026-08-18T06:00:01.000Z' }),
    (error: unknown) => error instanceof RulesPackError && error.code === 'COMPILE_UNAVAILABLE',
  );
  store.close();
});

test('identical future-lifecycle LKG works before its boundary and fails exactly at the boundary', () => {
  const store = new RulesStore(':memory:');
  const baseline = makeRule({ id: 'timed-baseline', text: 'Baseline before the activation time.' });
  const futureMandatory = makeRule({
    id: 'timed-mandatory',
    text: 'Mandatory after activation.',
    mandatory: true,
    overridable: false,
    lifecycle: { status: 'approved', validFrom: '2026-08-18T06:00:30.000Z' },
  });
  store.replaceSourceSnapshot({
    source: sourceGeneration('gen-1', [baseline, futureMandatory]),
    rules: [baseline, futureMandatory],
  });
  const initial = new RulesPackEngine({
    store,
    mode: 'enforce',
    cacheTtlMs: 500,
    lastKnownGoodTtlMs: 60_000,
  }).compile({ subject, now: NOW });
  assert.deepEqual(
    initial.pack.rules.map((rule) => rule.id),
    ['timed-baseline'],
  );
  assert.equal(initial.pack.expiresAt, '2026-08-18T06:00:30.000Z');

  const transient = new RulesPackEngine({
    store,
    mode: 'enforce',
    lastKnownGoodTtlMs: 60_000,
    compiler: () => {
      throw new RulesPackError('COMPILE_UNAVAILABLE', 'temporary compiler outage');
    },
  });
  const beforeBoundary = transient.compile({ subject, now: '2026-08-18T06:00:01.000Z' });
  assert.equal(beforeBoundary.pack.lastKnownGood, true);
  assert.deepEqual(
    beforeBoundary.pack.rules.map((rule) => rule.id),
    ['timed-baseline'],
  );
  assert.throws(
    () => transient.compile({ subject, now: '2026-08-18T06:00:30.000Z' }),
    (error: unknown) => error instanceof RulesPackError && error.code === 'COMPILE_UNAVAILABLE',
  );
  store.close();
});

test('future conflict and dependency transitions are bounded by LKG expiry', () => {
  const store = new RulesStore(':memory:');
  const currentConflict = makeRule({
    id: 'current-conflict',
    text: 'Current conflict winner.',
    conflictKey: 'transition-style',
    priority: 1,
  });
  const futureConflict = makeRule({
    id: 'future-conflict',
    text: 'Future conflict winner.',
    conflictKey: 'transition-style',
    priority: 100,
    lifecycle: { status: 'approved', validFrom: '2026-08-18T06:00:30.000Z' },
  });
  const futureDependency = makeRule({
    id: 'future-dependency',
    text: 'Future dependency.',
    lifecycle: { status: 'approved', validFrom: '2026-08-18T06:00:30.000Z' },
  });
  const dependent = makeRule({
    id: 'dependent',
    text: 'Selected only with its future dependency.',
    dependencies: ['future-dependency'],
    priority: 50,
  });
  const rules = [currentConflict, futureConflict, futureDependency, dependent];
  store.replaceSourceSnapshot({ source: sourceGeneration('gen-1', rules), rules });
  const initial = new RulesPackEngine({
    store,
    mode: 'enforce',
    cacheTtlMs: 500,
    lastKnownGoodTtlMs: 60_000,
  }).compile({ subject, now: NOW });
  assert.equal(initial.pack.expiresAt, '2026-08-18T06:00:30.000Z');
  assert.deepEqual(
    initial.pack.rules.map((rule) => rule.id),
    ['current-conflict'],
  );

  const transient = new RulesPackEngine({
    store,
    mode: 'enforce',
    compiler: () => {
      throw new RulesPackError('COMPILE_UNAVAILABLE', 'temporary compiler outage');
    },
  });
  const beforeBoundary = transient.compile({ subject, now: '2026-08-18T06:00:01.000Z' });
  assert.equal(beforeBoundary.pack.lastKnownGood, true);
  assert.deepEqual(
    beforeBoundary.pack.rules.map((rule) => rule.id),
    ['current-conflict'],
  );
  assert.throws(
    () => transient.compile({ subject, now: '2026-08-18T06:00:30.000Z' }),
    (error: unknown) => error instanceof RulesPackError && error.code === 'COMPILE_UNAVAILABLE',
  );
  store.close();
});

test('LKG rejects a snapshot that removes a nonselected conflict participant', () => {
  const store = new RulesStore(':memory:');
  const selected = makeRule({
    id: 'selected-conflict',
    text: 'Selected conflict winner.',
    conflictKey: 'style',
    priority: 10,
  });
  const nonselected = makeRule({ id: 'nonselected-conflict', text: 'Lower conflict candidate.', conflictKey: 'style' });
  store.replaceSourceSnapshot({
    source: sourceGeneration('gen-1', [selected, nonselected]),
    rules: [selected, nonselected],
  });
  const initial = new RulesPackEngine({ store, mode: 'enforce', lastKnownGoodTtlMs: 60_000 }).compile({
    subject,
    now: NOW,
  });
  assert.deepEqual(
    initial.pack.rules.map((rule) => rule.id),
    ['selected-conflict'],
  );

  store.replaceSourceSnapshot({ source: sourceGeneration('gen-2', [selected]), rules: [selected] });
  const transient = new RulesPackEngine({
    store,
    mode: 'enforce',
    lastKnownGoodTtlMs: 60_000,
    compiler: () => {
      throw new RulesPackError('COMPILE_UNAVAILABLE', 'temporary compiler outage');
    },
  });
  assert.throws(
    () => transient.compile({ subject, now: '2026-08-18T06:00:01.000Z' }),
    (error: unknown) => error instanceof RulesPackError && error.code === 'COMPILE_UNAVAILABLE',
  );
  store.close();
});

test('LKG rejects mode, budget, subject, and source-generation identity changes', () => {
  const store = new RulesStore(':memory:');
  const current = makeRule({ id: 'identity-bound', text: 'Identity-bound Rule.' });
  store.replaceSourceSnapshot({ source: sourceGeneration('gen-1', [current]), rules: [current] });
  new RulesPackEngine({ store, mode: 'enforce', lastKnownGoodTtlMs: 60_000 }).compile({ subject, now: NOW });
  const transient = new RulesPackEngine({
    store,
    mode: 'enforce',
    lastKnownGoodTtlMs: 60_000,
    compiler: () => {
      throw new RulesPackError('COMPILE_UNAVAILABLE', 'temporary compiler outage');
    },
  });
  const changedRequests = [
    { subject, mode: 'shadow' as const },
    { subject, budget: { maxTokens: 1_999, maxCharacters: 8_000 } },
    { subject: { ...subject, taskId: 'different-task' } },
    {
      subject,
      sourceState: {
        rules: [current],
        generations: [sourceGeneration('gen-2', [current])],
        degradationReasons: [],
        usedLastKnownGood: false,
      },
    },
  ];
  for (const request of changedRequests) {
    assert.throws(
      () => transient.compile({ ...request, now: '2026-08-18T06:00:01.000Z' }),
      (error: unknown) => error instanceof RulesPackError && error.code === 'COMPILE_UNAVAILABLE',
    );
  }
  store.close();
});

test('compiled pack verification recomputes the declared source snapshot identity', () => {
  const store = new RulesStore(':memory:');
  const current = makeRule({ id: 'pack-snapshot', text: 'Snapshot-bound Rule.' });
  store.replaceSourceSnapshot({ source: sourceGeneration('gen-1', [current]), rules: [current] });
  const result = new RulesPackEngine({ store, mode: 'enforce' }).compile({ subject, now: NOW });
  const selfConsistentlyTampered = recomputePackDigest({
    ...result.pack,
    sourceSnapshotDigest: 'sha256:pack-declared-but-not-recomputed',
  });
  assert.throws(
    () => verifyCompiledPack(selfConsistentlyTampered, NOW),
    (error: unknown) => error instanceof RulesPackError && error.code === 'VALIDATION_ERROR',
  );
  store.close();
});

test('tampered schema and source snapshot integrity fail closed without LKG', () => {
  const store = new RulesStore(':memory:');
  const current = makeRule({ id: 'integrity', text: 'Integrity checked Rule.' });
  store.replaceSourceSnapshot({ source: sourceGeneration('gen-1', [current]), rules: [current] });
  new RulesPackEngine({ store, mode: 'enforce' }).compile({ subject, now: NOW });
  const engine = new RulesPackEngine({
    store,
    mode: 'enforce',
    compiler: compileRules,
  });
  assert.throws(
    () =>
      engine.compile({
        subject,
        now: '2026-08-18T06:00:01.000Z',
        sourceState: {
          rules: [{ ...current, schemaVersion: 2 } as any],
          generations: [sourceGeneration('schema-tampered', [current])],
          degradationReasons: [],
          usedLastKnownGood: false,
        },
      }),
    (error: unknown) => error instanceof RulesPackError && error.code === 'VALIDATION_ERROR',
  );
  assert.throws(
    () =>
      engine.compile({
        subject,
        now: '2026-08-18T06:00:01.000Z',
        sourceState: {
          rules: [current],
          generations: [{ ...sourceGeneration('store-tampered', [current]), snapshotDigest: 'sha256:tampered' }],
          degradationReasons: [],
          usedLastKnownGood: false,
        },
      }),
    (error: unknown) => error instanceof RulesPackError && error.code === 'STORE_ERROR',
  );
  const expired = makeRule({
    id: current.id,
    text: current.text,
    version: '2',
    lifecycle: { status: 'approved', expiresAt: '2026-08-18T06:00:00.500Z' },
  });
  const unavailable = new RulesPackEngine({
    store,
    mode: 'enforce',
    compiler: () => {
      throw new RulesPackError('COMPILE_UNAVAILABLE', 'temporary compiler outage');
    },
  });
  assert.throws(
    () =>
      unavailable.compile({
        subject,
        now: '2026-08-18T06:00:01.000Z',
        sourceState: {
          rules: [expired],
          generations: [sourceGeneration('expired-current', [expired])],
          degradationReasons: [],
          usedLastKnownGood: false,
        },
      }),
    (error: unknown) => error instanceof RulesPackError && error.code === 'VALIDATION_ERROR',
  );
  store.close();
});

test('tampered persisted store JSON is a non-recoverable STORE_ERROR even when LKG exists', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rulespack-corrupt-store-'));
  const filename = join(directory, 'state.sqlite');
  const store = new RulesStore(filename);
  const current = makeRule({ id: 'stored-integrity', text: 'Persisted integrity Rule.' });
  store.replaceSourceSnapshot({ source: sourceGeneration('gen-1', [current]), rules: [current] });
  new RulesPackEngine({ store, mode: 'enforce' }).compile({ subject, now: NOW });
  const raw = new DatabaseSync(filename);
  raw.prepare("UPDATE current_rules SET rule_json = '{corrupt' WHERE id = ?").run(current.id);
  raw.prepare("UPDATE source_generations SET generation = 'tampered-store' WHERE source_id = 'test-config'").run();
  raw.close();
  assert.throws(
    () => new RulesPackEngine({ store, mode: 'enforce' }).compile({ subject, now: '2026-08-18T06:00:01.000Z' }),
    (error: unknown) => error instanceof RulesPackError && error.code === 'STORE_ERROR',
  );
  store.close();
});

test('optional source generations use bounded stored state and then degrade without expired LKG', async () => {
  const store = new RulesStore(':memory:');
  const original = makeRule({ id: 'source-lkg', text: 'Stored source Rule.' });
  store.replaceSourceSnapshot({ source: sourceGeneration('gen-1', [original]), rules: [original] });
  const failing: RuleSourceAdapter = {
    id: 'test-config',
    kind: 'config',
    required: false,
    load: async () => {
      throw new Error('source offline');
    },
  };
  const engine = new RulesPackEngine({ store, mode: 'enforce', lastKnownGoodTtlMs: 1_000 });
  const within = await engine.refreshSources([failing], { now: '2026-08-18T06:00:00.500Z' });
  assert.equal(within.usedLastKnownGood, true);
  assert.deepEqual(
    within.rules.map((rule) => rule.id),
    ['source-lkg'],
  );

  const expired = await engine.refreshSources([failing], { now: '2026-08-18T06:00:02.000Z' });
  assert.equal(expired.usedLastKnownGood, false);
  assert.equal(expired.rules.length, 0);
  assert.match(expired.degradationReasons[0] ?? '', /exceeded LKG bound/u);
  store.close();
});

test('source and audit diagnostics redact credential-like failures', async () => {
  const store = new RulesStore(':memory:');
  const engine = new RulesPackEngine({ store, mode: 'shadow' });
  const failing: RuleSourceAdapter = {
    id: 'credential-error-source',
    kind: 'config',
    required: false,
    load: async () => {
      throw new Error('Bearer abcdefghijklmnopqrstuvwxyz123456');
    },
  };
  const state = await engine.refreshSources([failing], { now: NOW });
  assert.equal(state.generations[0]?.error, '[REDACTED CREDENTIAL-LIKE DIAGNOSTIC]');
  assert.doesNotMatch(JSON.stringify(store.listAudit()), /abcdefghijklmnopqrstuvwxyz123456/u);
  store.close();
});

test('default hot-path cache hit does not reload the Rule set', () => {
  class CountingStore extends RulesStore {
    listCalls = 0;
    override listRules(sourceId?: string) {
      this.listCalls += 1;
      return super.listRules(sourceId);
    }
  }
  const store = new CountingStore(':memory:');
  const rule = makeRule({ id: 'indexed', text: 'Use indexed cache.' });
  store.replaceSourceSnapshot({ source: sourceGeneration('gen-1', [rule]), rules: [rule] });
  const engine = new RulesPackEngine({ store, mode: 'enforce' });
  engine.compile({ subject, now: NOW });
  const afterMiss = store.listCalls;
  engine.compile({ subject, now: NOW });
  assert.equal(store.listCalls, afterMiss);
  store.close();
});

test('freshness deadlines are evaluated at every compile/cache decision and expired optional Rules are not injected', async () => {
  const store = new RulesStore(':memory:');
  const engine = new RulesPackEngine({ store, mode: 'enforce', lastKnownGoodTtlMs: 500 });
  await engine.refreshSources(
    [
      configSource({
        id: 'fresh-config',
        revision: '1',
        freshForMs: 1_000,
        rules: [
          makeRule({
            id: 'fresh-only',
            text: 'Inject only while source is usable.',
            source: { kind: 'config', adapterId: 'fresh-config', ref: 'test', revision: '1' },
          }),
        ],
      }),
    ],
    { now: NOW },
  );
  const fresh = engine.compile({ subject, now: '2026-08-18T06:00:00.500Z' });
  const cached = engine.compile({ subject, now: '2026-08-18T06:00:00.600Z' });
  assert.match(fresh.injectionText, /Inject only/u);
  assert.equal(cached.telemetry.cache, 'hit-memory');

  const expired = engine.compile({ subject, now: '2026-08-18T06:00:02.000Z' });
  assert.doesNotMatch(expired.injectionText, /Inject only/u);
  assert.equal(expired.telemetry.cache, 'miss');
  assert.equal(expired.telemetry.sourceFreshness[0]?.health, 'unavailable');
  assert.equal(expired.telemetry.degraded, true);
  assert.equal(engine.currentSourceState('2026-08-18T06:00:02.000Z').generations[0]?.health, 'unavailable');
  store.close();
});

test('expired optional source uses only bounded stale generation and expired required source fails closed', async () => {
  const optionalStore = new RulesStore(':memory:');
  const optional = new RulesPackEngine({ store: optionalStore, mode: 'enforce', lastKnownGoodTtlMs: 2_000 });
  await optional.refreshSources(
    [
      configSource({
        id: 'optional',
        revision: '1',
        freshForMs: 1_000,
        rules: [
          makeRule({
            id: 'optional-rule',
            text: 'Bounded stale Rule.',
            source: { kind: 'config', adapterId: 'optional', ref: 'test', revision: '1' },
          }),
        ],
      }),
    ],
    { now: NOW },
  );
  const stale = optional.compile({ subject, now: '2026-08-18T06:00:01.500Z' });
  assert.match(stale.injectionText, /Bounded stale/u);
  assert.equal(stale.telemetry.sourceFreshness[0]?.health, 'stale');
  assert.equal(stale.telemetry.usedLastKnownGood, true);
  optionalStore.close();

  const requiredStore = new RulesStore(':memory:');
  const required = new RulesPackEngine({ store: requiredStore, mode: 'enforce' });
  await required.refreshSources(
    [configSource({ id: 'required', revision: '1', required: true, freshForMs: 1_000, rules: [] })],
    { now: NOW },
  );
  assert.throws(
    () => required.compile({ subject, now: '2026-08-18T06:00:01.001Z' }),
    (error: unknown) => error instanceof RulesPackError && error.code === 'SOURCE_UNAVAILABLE',
  );
  requiredStore.close();
});
