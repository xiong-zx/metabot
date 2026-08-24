import * as crypto from 'node:crypto';
import type * as http from 'node:http';

export const PEER_AUTH_SCHEME = 'MetaBotPeer';
export const PEER_CAPABILITY_VERSION = 1;
export const PEER_CAPABILITY_TTL_SECONDS = 30;
export const MIN_PEER_SECRET_LENGTH = 32;

export interface PeerCapabilityClaims {
  v: 1;
  iss: string;
  aud: string;
  kid: string;
  host: string;
  method: string;
  path: string;
  sourceBot: string;
  targetBot?: string;
  chatId?: string;
  taskId?: string;
  bodySha256: string;
  iat: number;
  exp: number;
  nonce: string;
}

export interface PeerAuthFailure {
  ok: false;
  status: 401 | 403;
  code:
    | 'peer_auth_missing'
    | 'peer_auth_malformed'
    | 'peer_auth_unknown_issuer'
    | 'peer_auth_unknown_key'
    | 'peer_auth_revoked'
    | 'peer_auth_bad_signature'
    | 'peer_auth_expired'
    | 'peer_auth_not_yet_valid'
    | 'peer_auth_audience'
    | 'peer_auth_host'
    | 'peer_auth_route'
    | 'peer_auth_body'
    | 'peer_auth_replay'
    | 'peer_auth_source_scope'
    | 'peer_auth_target_scope';
}

export type PeerAuthResult =
  | { ok: true; claims: PeerCapabilityClaims }
  | PeerAuthFailure;

interface ParsedPeerAuthorization {
  claims: PeerCapabilityClaims;
  encodedClaims: string;
  signature: Buffer;
}

const requestClaims = new WeakMap<http.IncomingMessage, PeerCapabilityClaims>();

export function setPeerRequestClaims(req: http.IncomingMessage, claims: PeerCapabilityClaims): void {
  requestClaims.set(req, claims);
}

export function getPeerRequestClaims(req: http.IncomingMessage): PeerCapabilityClaims | undefined {
  return requestClaims.get(req);
}

export function sha256Base64Url(body: string): string {
  return crypto.createHash('sha256').update(body).digest('base64url');
}

export function createPeerNonce(): string {
  return crypto.randomBytes(18).toString('base64url');
}

function isClaims(value: unknown): value is PeerCapabilityClaims {
  if (!value || typeof value !== 'object') return false;
  const claims = value as Record<string, unknown>;
  return claims.v === PEER_CAPABILITY_VERSION
    && typeof claims.iss === 'string' && claims.iss.length > 0
    && typeof claims.aud === 'string' && claims.aud.length > 0
    && typeof claims.kid === 'string' && claims.kid.length > 0
    && typeof claims.host === 'string' && claims.host.length > 0
    && typeof claims.method === 'string' && claims.method.length > 0
    && typeof claims.path === 'string' && claims.path.startsWith('/')
    && typeof claims.sourceBot === 'string' && claims.sourceBot.length > 0
    && typeof claims.bodySha256 === 'string' && claims.bodySha256.length > 0
    && typeof claims.iat === 'number' && Number.isInteger(claims.iat)
    && typeof claims.exp === 'number' && Number.isInteger(claims.exp)
    && typeof claims.nonce === 'string' && claims.nonce.length >= 16
    && (claims.targetBot === undefined || typeof claims.targetBot === 'string')
    && (claims.chatId === undefined || typeof claims.chatId === 'string')
    && (claims.taskId === undefined || typeof claims.taskId === 'string');
}

export function createPeerAuthorization(claims: PeerCapabilityClaims, secret: string): string {
  if (secret.length < MIN_PEER_SECRET_LENGTH) {
    throw new Error(`peer auth secret must contain at least ${MIN_PEER_SECRET_LENGTH} characters`);
  }
  const encodedClaims = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(encodedClaims).digest('base64url');
  return `${PEER_AUTH_SCHEME} ${encodedClaims}.${signature}`;
}

export function parsePeerAuthorization(
  authorization: string | string[] | undefined,
): ParsedPeerAuthorization | PeerAuthFailure {
  if (Array.isArray(authorization)) {
    return { ok: false, status: 401, code: 'peer_auth_malformed' };
  }
  if (!authorization) return { ok: false, status: 401, code: 'peer_auth_missing' };
  const match = authorization.match(/^MetaBotPeer\s+([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/i);
  if (!match || match[1].length > 8192 || match[2].length > 128) {
    return { ok: false, status: 401, code: 'peer_auth_malformed' };
  }
  try {
    const claims = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8')) as unknown;
    if (!isClaims(claims)) return { ok: false, status: 401, code: 'peer_auth_malformed' };
    return {
      claims,
      encodedClaims: match[1],
      signature: Buffer.from(match[2], 'base64url'),
    };
  } catch {
    return { ok: false, status: 401, code: 'peer_auth_malformed' };
  }
}

export function isPeerAuthorization(
  authorization: string | string[] | undefined,
): boolean {
  return typeof authorization === 'string' && /^MetaBotPeer\s/i.test(authorization);
}

export function verifyPeerAuthorizationSignature(
  parsed: ParsedPeerAuthorization,
  secret: string,
): boolean {
  if (secret.length < MIN_PEER_SECRET_LENGTH) return false;
  const expected = crypto.createHmac('sha256', secret).update(parsed.encodedClaims).digest();
  return parsed.signature.length === expected.length && crypto.timingSafeEqual(parsed.signature, expected);
}

export function peerAuthFailure(
  code: PeerAuthFailure['code'],
  status: 401 | 403 = 401,
): PeerAuthFailure {
  return { ok: false, status, code };
}
