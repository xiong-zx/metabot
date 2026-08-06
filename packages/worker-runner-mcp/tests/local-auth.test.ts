import { describe, expect, it } from 'vitest';
import { LocalCapabilityAuthority } from '../src/local-auth.js';

const KEY = Buffer.alloc(32, 7);
const PRINCIPAL = { role: 'pm' as const, botName: 'bot-a', chatId: 'chat-a' };

describe('local capability authentication', () => {
  it('binds purpose, principal, and expiry into the signed token', () => {
    let now = 1_000;
    const worker = new LocalCapabilityAuthority(KEY, 'worker-runner', () => now);
    const token = worker.issue(PRINCIPAL, { ttlMs: 100, nonce: 'request-1' });
    expect(worker.verify(token)).toMatchObject({
      claims: { purpose: 'worker-runner', nonce: 'request-1', expires_at: 1_100 },
      principal: PRINCIPAL,
    });

    expect(() => new LocalCapabilityAuthority(KEY, 'arc', () => now).verify(token)).toThrowError(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
    now = 1_100;
    expect(() => worker.verify(token)).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
  });

  it('rejects tampering and missing capabilities', () => {
    const authority = new LocalCapabilityAuthority(KEY, 'worker-runner', () => 1_000);
    const token = authority.issue(PRINCIPAL, { ttlMs: 100 });
    expect(() => authority.verify(`${token.slice(0, -1)}x`)).toThrowError(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
    expect(() => authority.verify('')).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
  });
});
