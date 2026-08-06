import { createHmac, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ExecutionCapabilityError,
  ExecutionCapabilityService,
  inspectExecutionKeyDirectory,
  provisionExecutionKeyPairs,
} from '../src/services/execution-capabilities.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function keyDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'metabot-execution-keys-'));
  dirs.push(dir);
  chmodSync(dir, 0o700);
  provisionExecutionKeyPairs(dir);
  return dir;
}

describe('execution capability Ed25519 keys', () => {
  it('provisions TOFU keypairs out of runtime without overwriting and diagnoses ownership/modes/pairs', () => {
    const dir = keyDir();
    const before = readFileSync(join(dir, 'worker-capability.key'), 'utf8');

    const second = provisionExecutionKeyPairs(dir);

    expect(readFileSync(join(dir, 'worker-capability.key'), 'utf8')).toBe(before);
    expect(second.ok).toBe(true);
    expect(second.trustModel).toBe('tofu-same-uid-scope-hygiene');
    expect(second.directory.mode).toBe(0o700);
    expect(second.pairs).toHaveLength(4);
    expect(second.pairs.every((pair) => pair.ok && pair.pairMatches)).toBe(true);
  });

  it('fails closed for missing, partial, mismatched, or overly permissive keys', () => {
    const missing = mkdtempSync(join(tmpdir(), 'metabot-execution-keys-missing-'));
    dirs.push(missing);
    chmodSync(missing, 0o700);
    const service = new ExecutionCapabilityService(missing);
    expect(() => service.issue({
      purpose: 'worker', role: 'pm', botName: 'pm-codex', chatId: 'chat-1',
    })).toThrowError(expect.objectContaining({ code: 'KEYS_UNAVAILABLE' }));

    const partial = keyDir();
    unlinkSync(join(partial, 'arc-capability.pub'));
    expect(() => provisionExecutionKeyPairs(partial)).toThrowError(
      expect.objectContaining({ code: 'INCOMPLETE_KEY_PAIR' }),
    );

    const mismatch = keyDir();
    const replacement = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
    writeFileSync(join(mismatch, 'worker-capability.pub'), replacement, { mode: 0o600 });
    expect(inspectExecutionKeyDirectory(mismatch).ok).toBe(false);
    expect(() => new ExecutionCapabilityService(mismatch).issue({
      purpose: 'worker', role: 'pm', botName: 'pm-codex', chatId: 'chat-1',
    })).toThrowError(expect.objectContaining({ code: 'KEY_PAIR_MISMATCH' }));

    const permissive = keyDir();
    chmodSync(join(permissive, 'worker-capability.key'), 0o644);
    expect(() => new ExecutionCapabilityService(permissive).issue({
      purpose: 'worker', role: 'pm', botName: 'pm-codex', chatId: 'chat-1',
    })).toThrowError(expect.objectContaining({ code: 'UNSAFE_KEY_PERMISSIONS' }));
  });

  it('keeps worker, ARC, callback, and W01-HMAC formats purpose-separated and enforces expiry', () => {
    const dir = keyDir();
    const service = new ExecutionCapabilityService(dir);
    const worker = service.issue({
      purpose: 'worker', role: 'pm', botName: 'pm-codex', chatId: 'chat-1', ttlMs: 1_000,
    }, 10_000);
    expect(service.verify(worker, {
      purpose: 'worker', botName: 'pm-codex', chatId: 'chat-1', now: 10_500,
    })).toMatchObject({ purpose: 'worker', role: 'pm' });
    expect(() => service.verify(worker, {
      purpose: 'arc', botName: 'pm-codex', chatId: 'chat-1', now: 10_500,
    })).toThrow(ExecutionCapabilityError);
    expect(() => service.verify(worker, {
      purpose: 'worker', botName: 'pm-codex', chatId: 'chat-1', now: 11_000,
    })).toThrowError(expect.objectContaining({ code: 'CAPABILITY_EXPIRED' }));
    expect(service.verify(worker, {
      purpose: 'worker', botName: 'pm-codex', chatId: 'chat-1', now: 99_000, ignoreExpiry: true,
    })).toMatchObject({ chatId: 'chat-1' });

    const [payload] = worker.split('.');
    const teamHmac = `${payload}.${createHmac('sha256', 'team-only').update(payload).digest('base64url')}`;
    expect(() => service.verify(teamHmac, {
      purpose: 'worker', botName: 'pm-codex', chatId: 'chat-1', now: 10_500,
    })).toThrowError(expect.objectContaining({ code: 'INVALID_SIGNATURE' }));

    const raw = Buffer.from('{"purpose":"worker.terminal"}');
    const callbackSignature = `ed25519:${cryptoSign(
      null,
      raw,
      readFileSync(join(dir, 'worker-callback.key'), 'utf8'),
    ).toString('base64')}`;
    expect(() => service.verifyTerminalCallbackSignature(raw, callbackSignature, 'worker.terminal')).not.toThrow();
    expect(() => service.verifyTerminalCallbackSignature(raw, callbackSignature, 'arc.terminal')).toThrow();
  });

  it('accepts the previous public key during rotation and rejects it after retirement', () => {
    const dir = keyDir();
    const oldService = new ExecutionCapabilityService(dir);
    const oldToken = oldService.issue({
      purpose: 'worker', role: 'user', botName: 'research', chatId: 'chat-2', ttlMs: 60_000,
    });
    renameSync(join(dir, 'worker-capability.pub'), join(dir, 'worker-capability.pub.prev'));
    renameSync(join(dir, 'worker-capability.key'), join(dir, 'worker-capability.key.old'));
    const next = generateKeyPairSync('ed25519');
    writeFileSync(join(dir, 'worker-capability.key'), next.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    writeFileSync(join(dir, 'worker-capability.pub'), next.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 });

    const rotated = new ExecutionCapabilityService(dir);
    expect(rotated.verify(oldToken, {
      purpose: 'worker', botName: 'research', chatId: 'chat-2',
    })).toMatchObject({ role: 'user' });

    unlinkSync(join(dir, 'worker-capability.pub.prev'));
    expect(() => new ExecutionCapabilityService(dir).verify(oldToken, {
      purpose: 'worker', botName: 'research', chatId: 'chat-2',
    })).toThrowError(expect.objectContaining({ code: 'INVALID_SIGNATURE' }));
  });
});
