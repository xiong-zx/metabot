import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LocalCapabilityVerifier,
  issueLocalCapability,
  readPrivateKeyFile,
  readPublicKeyFile,
} from '../src/local-auth.js';

const PRINCIPAL = { role: 'pm' as const, botName: 'bot-a', chatId: 'chat-a' };
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('local capability authentication', () => {
  it('verifies the exact Ed25519 v2.1 claims and expiry', () => {
    const keys = generateKeyPairSync('ed25519');
    let now = 1_000;
    const verifier = new LocalCapabilityVerifier([keys.publicKey], 'worker', () => now);
    const token = issueLocalCapability(keys.privateKey, {
      v: 1,
      purpose: 'worker',
      role: PRINCIPAL.role,
      botName: PRINCIPAL.botName,
      chatId: PRINCIPAL.chatId,
      exp: 1_100,
    });
    expect(verifier.verify(token)).toMatchObject({
      claims: { purpose: 'worker', botName: 'bot-a', chatId: 'chat-a', exp: 1_100 },
      principal: PRINCIPAL,
    });

    expect(() => new LocalCapabilityVerifier([keys.publicKey], 'arc', () => now).verify(token)).toThrowError(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
    now = 1_100;
    expect(() => verifier.verify(token)).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
  });

  it('accepts the previous public key and rejects tampering or extra claims', () => {
    const previous = generateKeyPairSync('ed25519');
    const current = generateKeyPairSync('ed25519');
    const token = issueLocalCapability(previous.privateKey, {
      v: 1,
      purpose: 'worker',
      role: 'pm',
      botName: 'bot-a',
      chatId: 'chat-a',
      exp: 2_000,
    });
    const rotated = new LocalCapabilityVerifier([current.publicKey, previous.publicKey], 'worker', () => 1_000);
    expect(rotated.verify(token).principal).toEqual(PRINCIPAL);
    expect(() => new LocalCapabilityVerifier([current.publicKey], 'worker', () => 1_000).verify(token)).toThrow();
    expect(() => rotated.verify(`${token.slice(0, -1)}x`)).toThrow();

    const claimsWithExtra = JSON.stringify({
      v: 1,
      purpose: 'worker',
      role: 'pm',
      botName: 'bot-a',
      chatId: 'chat-a',
      exp: 2_000,
      nonce: 'not-frozen',
    });
    const payload = Buffer.from(claimsWithExtra).toString('base64url');
    const extraToken = `${payload}.${cryptoSign(null, Buffer.from(payload), current.privateKey).toString('base64url')}`;
    expect(() => rotated.verify(extraToken)).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
  });

  it('loads only bounded regular non-symlink Ed25519 key files', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'worker-ed25519-'));
    directories.push(directory);
    const keys = generateKeyPairSync('ed25519');
    const publicPath = path.join(directory, 'capability.pub');
    const privatePath = path.join(directory, 'callback.key');
    writeFileSync(publicPath, keys.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 });
    writeFileSync(privatePath, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    expect(readPublicKeyFile(publicPath, 'capability').asymmetricKeyType).toBe('ed25519');
    expect(readPrivateKeyFile(privatePath, 'callback').asymmetricKeyType).toBe('ed25519');

    const linked = path.join(directory, 'linked.pub');
    symlinkSync(publicPath, linked);
    expect(() => readPublicKeyFile(linked, 'linked capability')).toThrow('regular non-symlink');
    const oversized = path.join(directory, 'oversized.pub');
    writeFileSync(oversized, Buffer.alloc(4_097), { mode: 0o600 });
    expect(() => readPublicKeyFile(oversized, 'oversized capability')).toThrow('64-4096');
  });
});
