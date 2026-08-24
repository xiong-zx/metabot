import { describe, expect, it } from 'vitest';
import { parsePeerAuthConfig } from '../src/api/routes/bot-routes.js';

const ACTIVE_SECRET = 'active-peer-key-0000000000000000000000000001';
const OLD_SECRET = 'old-peer-key-000000000000000000000000000002';

describe('dynamic peer auth configuration', () => {
  it('accepts an active key and bounded rotation keys', () => {
    expect(parsePeerAuthConfig({
      keyId: 'active-key',
      secret: ACTIVE_SECRET,
      sourceBot: 'source-bot',
      acceptKeys: [{
        keyId: 'old-key',
        secret: OLD_SECRET,
        acceptUntil: '2026-08-24T00:00:00.000Z',
      }],
      revokedKeyIds: ['revoked-key'],
      allowedSourceBots: ['source-bot'],
      allowedTargetBots: ['target-bot'],
    })).toMatchObject({
      keyId: 'active-key',
      sourceBot: 'source-bot',
      acceptKeys: [{ keyId: 'old-key', acceptUntil: '2026-08-24T00:00:00.000Z' }],
    });
  });

  it('rejects unbounded or malformed rotation keys and scopes', () => {
    expect(parsePeerAuthConfig({
      keyId: 'active-key',
      secret: ACTIVE_SECRET,
      acceptKeys: [{ keyId: 'old-key', secret: OLD_SECRET }],
    })).toBeUndefined();
    expect(parsePeerAuthConfig({
      keyId: 'active-key',
      secret: ACTIVE_SECRET,
      acceptKeys: [{ keyId: 'old-key', secret: OLD_SECRET, acceptUntil: 'not-a-date' }],
    })).toBeUndefined();
    expect(parsePeerAuthConfig({
      keyId: 'active-key',
      secret: ACTIVE_SECRET,
      allowedSourceBots: ['valid', 42],
    })).toBeUndefined();
    expect(parsePeerAuthConfig({
      keyId: 'active-key',
      secret: ACTIVE_SECRET,
      sourceBot: '   ',
    })).toBeUndefined();
  });
});
