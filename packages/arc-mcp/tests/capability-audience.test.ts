import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { ARC_CAPABILITY_AUDIENCE, ArcCapabilityVerifier, issueArcCapability } from '../src/local-auth.js';

const PRINCIPAL = { role: 'pm' as const, botName: 'research-pm', chatId: 'chat-a' };

/**
 * Every product server verifies its own audience before it evaluates a scope,
 * so a capability minted for a different server is refused on identity alone
 * even when the same issuer signed it.
 */
function signRaw(privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'], claims: unknown): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${cryptoSign(null, Buffer.from(payload), privateKey).toString('base64url')}`;
}

describe('ARC capability audience', () => {
  it('accepts an explicit aud=arc capability', () => {
    const keys = generateKeyPairSync('ed25519');
    const verifier = new ArcCapabilityVerifier([keys.publicKey], () => 1_000);
    const token = issueArcCapability(keys.privateKey, {
      v: 1,
      purpose: 'arc',
      aud: ARC_CAPABILITY_AUDIENCE,
      role: PRINCIPAL.role,
      botName: PRINCIPAL.botName,
      chatId: PRINCIPAL.chatId,
      exp: 1_100,
    });
    expect(verifier.verify(token)).toMatchObject({ claims: { aud: 'arc' }, principal: PRINCIPAL });
  });

  it('refuses a capability minted before audiences existed', () => {
    const keys = generateKeyPairSync('ed25519');
    const verifier = new ArcCapabilityVerifier([keys.publicKey], () => 1_000);
    // Such a token stays valid for up to an hour, so accepting it would hold
    // the pre-audience replay window open for exactly that long.
    const token = signRaw(keys.privateKey, {
      v: 1,
      purpose: 'arc',
      role: PRINCIPAL.role,
      botName: PRINCIPAL.botName,
      chatId: PRINCIPAL.chatId,
      exp: 1_100,
    });
    expect(() => verifier.verify(token)).toThrowError(
      expect.objectContaining({ code: 'scope_denied', message: expect.stringMatching(/v3 contract/i) }),
    );
  });

  it("refuses another server's audience even when the issuer key is trusted", () => {
    const keys = generateKeyPairSync('ed25519');
    const verifier = new ArcCapabilityVerifier([keys.publicKey], () => 1_000);
    const token = signRaw(keys.privateKey, {
      v: 1,
      purpose: 'arc',
      aud: 'metaclaw',
      role: PRINCIPAL.role,
      botName: PRINCIPAL.botName,
      chatId: PRINCIPAL.chatId,
      exp: 1_100,
    });
    expect(() => verifier.verify(token)).toThrowError(
      expect.objectContaining({ code: 'scope_denied', message: expect.stringMatching(/another audience/i) }),
    );
  });

  it('refuses an audience-shaped claim that is not a string audience', () => {
    const keys = generateKeyPairSync('ed25519');
    const verifier = new ArcCapabilityVerifier([keys.publicKey], () => 1_000);
    const token = signRaw(keys.privateKey, {
      v: 1,
      purpose: 'arc',
      aud: ['arc', 'metaclaw'],
      role: PRINCIPAL.role,
      botName: PRINCIPAL.botName,
      chatId: PRINCIPAL.chatId,
      exp: 1_100,
    });
    expect(() => verifier.verify(token)).toThrowError(expect.objectContaining({ code: 'scope_denied' }));
  });

  it('still refuses an unknown extra claim alongside a valid audience', () => {
    const keys = generateKeyPairSync('ed25519');
    const verifier = new ArcCapabilityVerifier([keys.publicKey], () => 1_000);
    const token = signRaw(keys.privateKey, {
      v: 1,
      purpose: 'arc',
      aud: ARC_CAPABILITY_AUDIENCE,
      scopes: ['arc:*'],
      role: PRINCIPAL.role,
      botName: PRINCIPAL.botName,
      chatId: PRINCIPAL.chatId,
      exp: 1_100,
    });
    expect(() => verifier.verify(token)).toThrowError(expect.objectContaining({ code: 'scope_denied' }));
  });
});
