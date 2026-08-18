import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ArcCapabilityVerifier,
  issueArcCapability,
  readArcPrivateKeyFile,
  readArcPublicKeyFile,
} from '../src/local-auth.js';

const PRINCIPAL = { role: 'pm' as const, botName: 'research-pm', chatId: 'chat-a' };
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('ARC local capability', () => {
  it('verifies the exact Ed25519 ARC claims and expiry', () => {
    const keys = generateKeyPairSync('ed25519');
    let now = 1_000;
    const verifier = new ArcCapabilityVerifier([keys.publicKey], () => now);
    const token = issueArcCapability(keys.privateKey, {
      v: 1,
      purpose: 'arc',
      aud: 'arc',
      role: PRINCIPAL.role,
      botName: PRINCIPAL.botName,
      chatId: PRINCIPAL.chatId,
      exp: 1_100,
    });
    expect(verifier.verify(token)).toMatchObject({
      claims: { purpose: 'arc', botName: 'research-pm', chatId: 'chat-a', exp: 1_100 },
      principal: PRINCIPAL,
    });
    now = 1_100;
    expect(() => verifier.verify(token)).toThrowError(expect.objectContaining({ code: 'scope_denied' }));
  });

  it('accepts the previous public key and rejects tampering or extra claims', () => {
    const previous = generateKeyPairSync('ed25519');
    const current = generateKeyPairSync('ed25519');
    const token = issueArcCapability(previous.privateKey, {
      v: 1,
      purpose: 'arc',
      aud: 'arc',
      role: 'pm',
      botName: 'research-pm',
      chatId: 'chat-a',
      exp: 2_000,
    });
    const rotated = new ArcCapabilityVerifier([current.publicKey, previous.publicKey], () => 1_000);
    expect(rotated.verify(token).principal).toEqual(PRINCIPAL);
    expect(() => new ArcCapabilityVerifier([current.publicKey], () => 1_000).verify(token)).toThrow();
    expect(() => rotated.verify(`${token.slice(0, -1)}x`)).toThrow();

    const payload = Buffer.from(
      JSON.stringify({
        v: 1,
        purpose: 'arc',
        aud: 'arc',
        role: 'pm',
        botName: 'research-pm',
        chatId: 'chat-a',
        exp: 2_000,
        nonce: 'not-frozen',
      }),
    ).toString('base64url');
    const extraToken = `${payload}.${cryptoSign(null, Buffer.from(payload), current.privateKey).toString('base64url')}`;
    expect(() => rotated.verify(extraToken)).toThrowError(expect.objectContaining({ code: 'scope_denied' }));
  });

  it('loads only bounded regular non-symlink Ed25519 key files', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'arc-ed25519-'));
    directories.push(directory);
    const keys = generateKeyPairSync('ed25519');
    const publicPath = path.join(directory, 'capability.pub');
    const privatePath = path.join(directory, 'callback.key');
    writeFileSync(publicPath, keys.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 });
    writeFileSync(privatePath, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    expect(readArcPublicKeyFile(publicPath, 'capability').asymmetricKeyType).toBe('ed25519');
    expect(readArcPrivateKeyFile(privatePath, 'callback').asymmetricKeyType).toBe('ed25519');

    const linked = path.join(directory, 'linked.pub');
    symlinkSync(publicPath, linked);
    expect(() => readArcPublicKeyFile(linked, 'linked capability')).toThrow('regular non-symlink');
    const oversized = path.join(directory, 'oversized.pub');
    writeFileSync(oversized, Buffer.alloc(4_097), { mode: 0o600 });
    expect(() => readArcPublicKeyFile(oversized, 'oversized capability')).toThrow('64-4096');
  });
});
