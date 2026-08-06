import { describe, expect, it } from 'vitest';

import { ArcCapabilityAuthority } from '../src/local-auth.js';

const KEY = Buffer.alloc(32, 3);
const PRINCIPAL = { role: 'pm' as const, botName: 'research-pm', chatId: 'chat-a' };

describe('ARC local capability', () => {
  it('binds the ARC purpose, connection principal, and expiry', () => {
    let now = 1_000;
    const authority = new ArcCapabilityAuthority(KEY, () => now);
    const token = authority.issue(PRINCIPAL, { ttlMs: 100, nonce: 'session-1' });
    expect(authority.verify(token)).toMatchObject({
      claims: { purpose: 'arc', nonce: 'session-1', expires_at: 1_100 },
      principal: PRINCIPAL,
    });
    now = 1_100;
    expect(() => authority.verify(token)).toThrowError(expect.objectContaining({ code: 'scope_denied' }));
  });

  it('rejects missing and tampered tokens', () => {
    const authority = new ArcCapabilityAuthority(KEY, () => 1_000);
    const token = authority.issue(PRINCIPAL, { ttlMs: 100 });
    expect(() => authority.verify('')).toThrowError(expect.objectContaining({ code: 'scope_denied' }));
    expect(() => authority.verify(`${token.slice(0, -1)}x`)).toThrowError(
      expect.objectContaining({ code: 'scope_denied' }),
    );
  });
});
