import { afterEach, describe, expect, it, vi } from 'vitest';
import { PeerManager } from '../src/api/peer-manager.js';
import {
  createPeerAuthorization,
  parsePeerAuthorization,
  sha256Base64Url,
  type PeerCapabilityClaims,
} from '../src/api/peer-auth.js';

const SHARED_KEY = 'peer-scoped-test-key-000000000000000000000001';
const NOW_MS = 1_800_000_000_000;

function logger() {
  const value = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child: vi.fn() } as any;
  value.child.mockReturnValue(value);
  return value;
}

function claims(overrides: Partial<PeerCapabilityClaims> = {}): PeerCapabilityClaims {
  const rawBody = JSON.stringify({
    botName: 'bot-savio',
    chatId: 'chat-1',
    prompt: 'hello',
    sourceBot: 'bot-imac',
    requestId: 'request-1',
    async: true,
  });
  return {
    v: 1,
    iss: 'imac',
    aud: 'savio',
    kid: 'imac-savio-2026-08',
    host: '127.0.0.1:19110',
    method: 'POST',
    path: '/api/talk',
    sourceBot: 'bot-imac',
    targetBot: 'bot-savio',
    chatId: 'chat-1',
    taskId: 'request-1',
    bodySha256: sha256Base64Url(rawBody),
    iat: Math.floor(NOW_MS / 1000),
    exp: Math.floor(NOW_MS / 1000) + 30,
    nonce: 'nonce-000000000000000001',
    ...overrides,
  };
}

function requestBody(): string {
  return JSON.stringify({
    botName: 'bot-savio',
    chatId: 'chat-1',
    prompt: 'hello',
    sourceBot: 'bot-imac',
    requestId: 'request-1',
    async: true,
  });
}

describe('peer-scoped capability authentication', () => {
  let manager: PeerManager | undefined;

  afterEach(() => manager?.destroy());

  function makeManager(authOverrides: Record<string, unknown> = {}) {
    manager = new PeerManager(
      [{
        name: 'imac',
        url: 'http://127.0.0.1:19111',
        auth: {
          keyId: 'imac-savio-2026-08',
          secret: SHARED_KEY,
          allowedSourceBots: ['bot-imac'],
          allowedTargetBots: ['bot-savio'],
          ...authOverrides,
        },
      }],
      [{ name: 'bot-savio' }],
      logger(),
      { peerIdentity: 'savio', now: () => NOW_MS },
    );
    return manager;
  }

  it('does not place the peer secret in the signed capability', () => {
    const authorization = createPeerAuthorization(claims(), SHARED_KEY);
    expect(authorization).toMatch(/^MetaBotPeer /);
    expect(authorization).not.toContain(SHARED_KEY);
    expect(parsePeerAuthorization(authorization)).toMatchObject({ claims: { iss: 'imac', aud: 'savio' } });
  });

  it('binds issuer, audience, host, route, bots, chat, request, expiry, nonce, and body digest', () => {
    const verifier = makeManager();
    const authorization = createPeerAuthorization(claims(), SHARED_KEY);
    const input = {
      authorization,
      method: 'POST',
      path: '/api/talk',
      host: '127.0.0.1:19110',
      origin: 'peer',
      rawBody: requestBody(),
    };
    expect(verifier.verifyInboundPeerRequest(input)).toMatchObject({ ok: true });
    expect(verifier.verifyInboundPeerRequest(input)).toEqual({
      ok: false,
      status: 401,
      code: 'peer_auth_replay',
    });
  });

  it('binds a RulesPack issuer independently from the local source Bot', () => {
    const verifier = makeManager();
    const body = JSON.stringify({
      botName: 'bot-savio',
      chatId: 'chat-1',
      prompt: 'hello',
      sourceBot: 'bot-imac',
      requestId: 'request-1',
      async: true,
      rulesPackDispatch: { issuer: 'metabot-core-admin' },
    });
    const signed = claims({
      rulesPackIssuer: 'metabot-core-admin',
      bodySha256: sha256Base64Url(body),
      nonce: 'nonce-000000000000000020',
    });
    expect(verifier.verifyInboundPeerRequest({
      authorization: createPeerAuthorization(signed, SHARED_KEY),
      method: 'POST',
      path: '/api/talk',
      host: '127.0.0.1:19110',
      origin: 'peer',
      rawBody: body,
    })).toMatchObject({
      ok: true,
      claims: { sourceBot: 'bot-imac', rulesPackIssuer: 'metabot-core-admin' },
    });

    expect(verifier.verifyInboundPeerRequest({
      authorization: createPeerAuthorization({
        ...signed,
        rulesPackIssuer: 'different-issuer',
        nonce: 'nonce-000000000000000021',
      }, SHARED_KEY),
      method: 'POST',
      path: '/api/talk',
      host: '127.0.0.1:19110',
      origin: 'peer',
      rawBody: body,
    })).toMatchObject({ ok: false, code: 'peer_auth_body' });
  });

  it.each([
    ['audience', { aud: 'other' }, {}, 'peer_auth_audience'],
    ['host', { host: '127.0.0.1:9999' }, {}, 'peer_auth_host'],
    ['route', { path: '/api/restart' }, { path: '/api/restart' }, 'peer_auth_route'],
    ['expiry', { iat: Math.floor(NOW_MS / 1000) - 60, exp: Math.floor(NOW_MS / 1000) - 1 }, {}, 'peer_auth_expired'],
    ['source scope', { sourceBot: 'unknown-bot' }, {}, 'peer_auth_source_scope'],
    ['target scope', { targetBot: 'other-bot' }, {}, 'peer_auth_target_scope'],
  ])('rejects wrong %s binding', (_label, claimOverrides, inputOverrides, code) => {
    const verifier = makeManager();
    const authorization = createPeerAuthorization(claims(claimOverrides), SHARED_KEY);
    expect(verifier.verifyInboundPeerRequest({
      authorization,
      method: 'POST',
      path: '/api/talk',
      host: '127.0.0.1:19110',
      origin: 'peer',
      rawBody: requestBody(),
      ...inputOverrides,
    })).toMatchObject({ ok: false, code });
  });

  it('rejects tampering and explicitly revoked keys', () => {
    const verifier = makeManager();
    const authorization = createPeerAuthorization(claims(), SHARED_KEY);
    expect(verifier.verifyInboundPeerRequest({
      authorization,
      method: 'POST',
      path: '/api/talk',
      host: '127.0.0.1:19110',
      origin: 'peer',
      rawBody: requestBody().replace('hello', 'tampered'),
    })).toMatchObject({ ok: false, code: 'peer_auth_body' });
    manager?.destroy();

    const revoked = makeManager({ revokedKeyIds: ['imac-savio-2026-08'] });
    expect(revoked.verifyInboundPeerRequest({
      authorization,
      method: 'POST',
      path: '/api/talk',
      host: '127.0.0.1:19110',
      origin: 'peer',
      rawBody: requestBody(),
    })).toMatchObject({ ok: false, code: 'peer_auth_revoked' });
  });

  it.each([
    ['POST', '/api/peers'],
    ['POST', '/api/bots'],
    ['POST', '/api/restart'],
    ['POST', '/api/agent-teams'],
    ['GET', '/api/status'],
    ['GET', '/api/files/private'],
    ['GET', '/api/sessions'],
  ])('never grants peer capability access to %s %s', (method, path) => {
    const verifier = makeManager();
    const restrictedClaims = claims({
      method,
      path,
      targetBot: undefined,
      chatId: undefined,
      taskId: undefined,
      bodySha256: sha256Base64Url(''),
    });
    expect(verifier.verifyInboundPeerRequest({
      authorization: createPeerAuthorization(restrictedClaims, SHARED_KEY),
      method,
      path,
      host: '127.0.0.1:19110',
      origin: 'peer',
      rawBody: '',
    })).toMatchObject({ ok: false, code: 'peer_auth_route' });
  });

  it('requires the peer origin marker and rejects unknown issuers and signatures', () => {
    const verifier = makeManager();
    const discoveryClaims = claims({
      method: 'GET',
      path: '/api/bots',
      targetBot: undefined,
      chatId: undefined,
      taskId: undefined,
      bodySha256: sha256Base64Url(''),
      nonce: 'nonce-000000000000000010',
    });
    const authorization = createPeerAuthorization(discoveryClaims, SHARED_KEY);
    expect(verifier.verifyInboundPeerRequest({
      authorization,
      method: 'GET',
      path: '/api/bots',
      host: '127.0.0.1:19110',
      origin: undefined,
      rawBody: '',
    })).toMatchObject({ ok: false, code: 'peer_auth_route' });

    expect(verifier.verifyInboundPeerRequest({
      authorization: createPeerAuthorization({ ...discoveryClaims, iss: 'unknown-peer' }, SHARED_KEY),
      method: 'GET',
      path: '/api/bots',
      host: '127.0.0.1:19110',
      origin: 'peer',
      rawBody: '',
    })).toMatchObject({ ok: false, code: 'peer_auth_unknown_issuer' });

    expect(verifier.verifyInboundPeerRequest({
      authorization: createPeerAuthorization(
        { ...discoveryClaims, nonce: 'nonce-000000000000000011' },
        'different-peer-key-00000000000000000000000002',
      ),
      method: 'GET',
      path: '/api/bots',
      host: '127.0.0.1:19110',
      origin: 'peer',
      rawBody: '',
    })).toMatchObject({ ok: false, code: 'peer_auth_bad_signature' });
  });

  it('supports bounded key rotation without accepting an expired old key', () => {
    const oldClaims = claims({ kid: 'old-key' });
    const oldAuthorization = createPeerAuthorization(oldClaims, SHARED_KEY);
    const verifier = makeManager({
      keyId: 'new-key',
      secret: 'peer-scoped-new-key-0000000000000000000000002',
      acceptKeys: [{
        keyId: 'old-key',
        secret: SHARED_KEY,
        acceptUntil: new Date(NOW_MS + 60_000).toISOString(),
      }],
    });
    expect(verifier.verifyInboundPeerRequest({
      authorization: oldAuthorization,
      method: 'POST',
      path: '/api/talk',
      host: '127.0.0.1:19110',
      origin: 'peer',
      rawBody: requestBody(),
    })).toMatchObject({ ok: true });

    manager?.destroy();
    const expired = makeManager({
      keyId: 'new-key',
      secret: 'peer-scoped-new-key-0000000000000000000000002',
      acceptKeys: [{
        keyId: 'old-key',
        secret: SHARED_KEY,
        acceptUntil: new Date(NOW_MS - 1).toISOString(),
      }],
    });
    expect(expired.verifyInboundPeerRequest({
      authorization: oldAuthorization,
      method: 'POST',
      path: '/api/talk',
      host: '127.0.0.1:19110',
      origin: 'peer',
      rawBody: requestBody(),
    })).toMatchObject({ ok: false, code: 'peer_auth_unknown_key' });
  });

  it('rejects an accepted rotation key that has no bounded cutoff', () => {
    const oldClaims = claims({ kid: 'old-key', nonce: 'nonce-000000000000000020' });
    const oldAuthorization = createPeerAuthorization(oldClaims, SHARED_KEY);
    const verifier = makeManager({
      keyId: 'new-key',
      secret: 'peer-scoped-new-key-0000000000000000000000002',
      acceptKeys: [{ keyId: 'old-key', secret: SHARED_KEY }],
    });
    expect(verifier.verifyInboundPeerRequest({
      authorization: oldAuthorization,
      method: 'POST',
      path: '/api/talk',
      host: '127.0.0.1:19110',
      origin: 'peer',
      rawBody: requestBody(),
    })).toMatchObject({ ok: false, code: 'peer_auth_unknown_key' });
  });
});
