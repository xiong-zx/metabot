import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RulesPackEngine } from '../src/engine.js';
import { verifyCompiledPack } from '../src/compiler.js';
import type { RuleSourceAdapter } from '../src/sources.js';
import { RulesStore } from '../src/store.js';
import { makeRule, NOW, sourceGeneration, subject } from './fixtures.js';

test('SQLite persists normalized Rules, generations, audit, receipts, feedback, cache, and LKG', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rulespack-store-'));
  const filename = join(directory, 'state.sqlite');
  const rule = makeRule({ id: 'persisted', text: 'Persist this rule.' });
  const source = sourceGeneration();
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
  assert.ok(store.getLastKnownGood(result.pack.subjectFingerprint, NOW));
  store.close();
});

test('cache hits, source generation invalidation, and revocation-first safety work', () => {
  const store = new RulesStore(':memory:');
  const original = makeRule({ id: 'cached', text: 'Original cached rule.' });
  store.replaceSourceSnapshot({ source: sourceGeneration('gen-1'), rules: [original] });
  const engine = new RulesPackEngine({ store, mode: 'enforce' });
  const first = engine.compile({ subject, now: NOW });
  const second = engine.compile({ subject, now: NOW });
  assert.equal(first.telemetry.cache, 'miss');
  assert.equal(second.telemetry.cache, 'hit-memory');

  const changed = makeRule({ id: 'cached', text: 'Changed generation rule.', version: '2' });
  store.replaceSourceSnapshot({ source: sourceGeneration('gen-2'), rules: [changed] });
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

test('bounded last-known-good is used only for non-safety compile failure and never resurrects revocation', () => {
  const store = new RulesStore(':memory:');
  const original = makeRule({ id: 'lkg', text: 'Known good rule.' });
  store.replaceSourceSnapshot({ source: sourceGeneration(), rules: [original] });
  const engine = new RulesPackEngine({ store, mode: 'enforce', lastKnownGoodTtlMs: 60_000 });
  const first = engine.compile({ subject, now: NOW });
  const corrupt = { ...original, digest: 'sha256:corrupt' };
  const fallback = engine.compile({
    subject,
    now: '2026-08-18T06:00:01.000Z',
    sourceState: {
      rules: [corrupt],
      generations: [sourceGeneration('corrupt-gen')],
      degradationReasons: ['test source corruption'],
      usedLastKnownGood: false,
    },
  });
  assert.notEqual(fallback.pack.packDigest, first.pack.packDigest);
  assert.deepEqual(fallback.pack.rules.map((rule) => rule.id), first.pack.rules.map((rule) => rule.id));
  assert.equal(fallback.pack.lastKnownGood, true);
  assert.equal(fallback.telemetry.usedLastKnownGood, true);
  assert.equal(verifyCompiledPack(fallback.pack, '2026-08-18T06:00:01.000Z'), fallback.pack);

  store.revokeRule('lkg', 'revoked before retry', '2026-08-18T06:00:02.000Z');
  assert.equal(store.getLastKnownGood(first.pack.subjectFingerprint, '2026-08-18T06:00:03.000Z'), undefined);
  store.close();
});

test('optional source generations use bounded stored state and then degrade without expired LKG', async () => {
  const store = new RulesStore(':memory:');
  const original = makeRule({ id: 'source-lkg', text: 'Stored source Rule.' });
  store.replaceSourceSnapshot({ source: sourceGeneration(), rules: [original] });
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
  assert.deepEqual(within.rules.map((rule) => rule.id), ['source-lkg']);

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
  store.replaceSourceSnapshot({ source: sourceGeneration(), rules: [rule] });
  const engine = new RulesPackEngine({ store, mode: 'enforce' });
  engine.compile({ subject, now: NOW });
  const afterMiss = store.listCalls;
  engine.compile({ subject, now: NOW });
  assert.equal(store.listCalls, afterMiss);
  store.close();
});
