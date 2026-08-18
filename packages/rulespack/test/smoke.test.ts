import assert from 'node:assert/strict';
import test from 'node:test';
import { eventId } from '../src/canonical.js';
import { RulesPackEngine } from '../src/engine.js';
import { configSource, temporarySource } from '../src/sources.js';
import { RulesStore } from '../src/store.js';
import { validateDispatchEnvelope, type RulesPackDispatchEnvelopeV1 } from '../src/transport.js';
import { RulesPackError } from '../src/errors.js';
import { makeRule, NOW, subject } from './fixtures.js';

test('realistic isolated Codex flow selects target-bound subset, injects, dispatches, receipts, and explains non-target isolation', async () => {
  const store = new RulesStore(':memory:');
  const engine = new RulesPackEngine({ store, mode: 'enforce' });
  const global = makeRule({ id: 'global-style', text: 'Report outcomes concisely.' });
  const project = makeRule({
    id: 'fix-boundary',
    text: 'Keep all writes inside the FIX-009 project.',
    scope: 'project',
    binding: { projectId: 'fix-009' },
    targets: { include: { bots: ['admin'], hosts: ['imac'] } },
  });
  const temporary = makeRule({
    id: 'task-temp',
    text: 'Run focused tests for this task.',
    scope: 'task',
    binding: { taskId: 'task-implement', chatId: 'chat-fix-009' },
    authority: 'user-current',
    lifecycle: { status: 'approved', expiresAt: '2026-08-18T07:00:00.000Z' },
    source: { kind: 'temporary', adapterId: 'temp', ref: 'command', revision: '1' },
  });
  const sourceState = await engine.refreshSources([
    configSource({ id: 'config', revision: '1', rules: [global, project] }),
    temporarySource({ id: 'temp', revision: '1', rules: [temporary] }),
  ], { now: NOW });
  const result = engine.compile({ subject, sourceState, now: NOW });
  assert.deepEqual(result.pack.rules.map((rule) => rule.id), ['task-temp', 'fix-boundary', 'global-style']);
  assert.match(result.injectionText, /BEGIN RULESPACK DATA/u);
  assert.equal(result.pack.deliveryChannel, 'user');
  assert.equal(result.telemetry.degraded, false);

  const envelope: RulesPackDispatchEnvelopeV1 = {
    schemaVersion: 1,
    envelopeId: eventId('dispatch'),
    issuer: 'admin@imac',
    audience: 'codex-worker@imac',
    replayId: 'replay-1',
    issuedAt: NOW,
    expiresAt: '2026-08-18T06:10:00.000Z',
    subjectFingerprint: result.pack.subjectFingerprint,
    target: subject,
    packDigest: result.pack.packDigest,
    pack: result.pack,
    required: true,
  };
  assert.equal(validateDispatchEnvelope(envelope, { audience: envelope.audience, target: subject, now: NOW }), envelope);
  const tampered: RulesPackDispatchEnvelopeV1 = {
    ...envelope,
    pack: { ...envelope.pack, renderedText: `${envelope.pack.renderedText}\nTampered` },
  };
  assert.throws(
    () => validateDispatchEnvelope(tampered, { audience: envelope.audience, target: subject, now: NOW }),
    (error: unknown) => error instanceof RulesPackError && error.code === 'VALIDATION_ERROR',
  );
  store.recordReceipt({
    receiptId: 'smoke-receipt',
    packDigest: result.pack.packDigest,
    subjectFingerprint: result.pack.subjectFingerprint,
    target: subject,
    status: 'consumed',
    channel: 'user',
    occurredAt: NOW,
    issuer: envelope.issuer,
    audience: envelope.audience,
    replayId: envelope.replayId,
  });
  assert.equal(store.listReceipts(result.pack.packDigest).length, 1);

  const other = engine.compile({
    subject: { ...subject, bot: 'pm', projectId: 'other', chatId: 'unrelated', taskId: 'other-task' },
    sourceState,
    now: NOW,
  });
  assert.deepEqual(other.pack.rules.map((rule) => rule.id), ['global-style']);
  assert.equal(other.pack.decisions.find((item) => item.ruleId === 'fix-boundary')?.disposition, 'scope-mismatch');
  assert.equal(other.pack.decisions.find((item) => item.ruleId === 'task-temp')?.disposition, 'scope-mismatch');
  store.close();
});
