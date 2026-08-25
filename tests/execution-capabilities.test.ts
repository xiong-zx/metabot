import { createHmac, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MetaBotRulesPackRuntime } from '@metabot/rulespack-adapter';
import { LocalCapabilityVerifier, readPublicKeyFile } from '../packages/worker-runner-mcp/src/local-auth.js';
import {
  ExecutionCapabilityError,
  ExecutionCapabilityService,
  EXECUTION_PRINCIPAL_BOT_NAME_MAX_LENGTH,
  EXECUTION_PRINCIPAL_CHAT_ID_MAX_LENGTH,
  inspectExecutionKeyDirectory,
  EXECUTION_PUBLIC_KEY_MODES,
  provisionExecutionKeyPairs,
  type ExecutionCapabilityClaims,
} from '../src/services/execution-capabilities.js';
import { capabilityServers, loopbackProxyServers } from '../src/services/mcp-registry.js';

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

function signCapabilityClaims(dir: string, claims: ExecutionCapabilityClaims): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = cryptoSign(
    null,
    Buffer.from(payload),
    readFileSync(join(dir, `${claims.purpose}-capability.key`), 'utf8'),
  ).toString('base64url');
  return `${payload}.${signature}`;
}

describe('execution capability Ed25519 keys', () => {
  it('signs a capability-bound, expiring Worker child grant and rejects tamper or cross-capability use', async () => {
    const dir = keyDir();
    const service = new ExecutionCapabilityService(dir);
    const now = 1_000_000;
    const token = service.issue({
      purpose: 'worker', role: 'pm', botName: 'pm-codex', chatId: 'chat-1', ttlMs: 10_000,
    }, now);
    const runtime = new MetaBotRulesPackRuntime({
      mode: 'enforce',
      hostId: 'sender',
      dbPath: join(dir, 'grant-sender.sqlite'),
      dispatch: { issuer: 'remote-bridge' },
      configRules: {
        id: 'grant', revision: '1', rules: [{
          schemaVersion: 1, id: 'grant-rule', version: '1', text: 'Grant policy.', scope: 'global',
          targets: {}, authority: 'user-approved', priority: 1, overridable: false,
          lifecycle: { status: 'approved' },
          source: { kind: 'config', adapterId: 'grant', ref: 'grant', revision: '1' },
        }],
      },
    }, { debug() {}, info() {}, warn() {}, error() {} });
    try {
      const parent = await runtime.createDispatchEnvelope({
        targetSubject: {
          hostId: 'imac', bot: 'pm-codex', roles: ['pm'], chatId: 'chat-1',
          projectId: 'metabot', tools: ['metabot-worker'], dataClasses: ['agent-bus'],
          outputTypes: ['text'], engine: 'codex',
        },
        audience: 'metabot-host:imac', now: new Date(now).toISOString(), ttlMs: 5_000,
      });
      const grant = service.issueRulesPackChildGrant(token, parent, now);
      const verifier = new LocalCapabilityVerifier([
        readPublicKeyFile(join(dir, 'worker-capability.pub'), 'worker capability'),
      ], 'worker', () => now + 1);
      expect(verifier.verifyRulesPackChildGrant(grant, token)).toMatchObject({
        purpose: 'worker', depth: 1, constraints: { bot: 'pm-codex', chatId: 'chat-1', projectId: 'metabot' },
      });
      expect(() => verifier.verifyRulesPackChildGrant({
        ...grant, constraints: { ...grant.constraints, projectId: 'other' },
      }, token)).toThrow(/signature/u);
      const otherToken = service.issue({
        purpose: 'worker', role: 'pm', botName: 'pm-codex', chatId: 'chat-1', ttlMs: 9_000,
      }, now);
      expect(() => verifier.verifyRulesPackChildGrant(grant, otherToken)).toThrow(/capability binding/u);
      const expired = new LocalCapabilityVerifier([
        readPublicKeyFile(join(dir, 'worker-capability.pub'), 'worker capability'),
      ], 'worker', () => now + 5_000);
      expect(() => expired.verifyRulesPackChildGrant(grant, token)).toThrow(/expired/u);
    } finally {
      runtime.close();
    }
  });

  it('provisions TOFU keypairs out of runtime without overwriting and diagnoses ownership/modes/pairs', () => {
    const dir = keyDir();
    const before = readFileSync(join(dir, 'worker-capability.key'), 'utf8');

    const second = provisionExecutionKeyPairs(dir);

    expect(readFileSync(join(dir, 'worker-capability.key'), 'utf8')).toBe(before);
    expect(second.ok).toBe(true);
    expect(second.trustModel).toBe('tofu-same-uid-scope-hygiene');
    expect(second.directory.mode).toBe(0o700);
    // Derived from the audience table rather than a fixed count, so registering
    // a server adds its keypair here instead of failing this assertion.
    expect(second.pairs.map((pair) => pair.name)).toEqual([
      ...capabilityServers().map((server) => `${server.id}-capability`),
      ...loopbackProxyServers().map((server) => `${server.id}-callback`),
    ]);
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
    unlinkSync(join(partial, 'worker-callback.pub'));
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

  it('accepts read-only public-key modes while keeping private keys at 0600', () => {
    for (const mode of EXECUTION_PUBLIC_KEY_MODES) {
      const dir = keyDir();
      chmodSync(join(dir, 'worker-capability.pub'), mode);
      const service = new ExecutionCapabilityService(dir);
      expect(() => service.issue({
        purpose: 'worker', role: 'user', botName: 'pm-codex', chatId: 'chat-1',
      })).not.toThrow();
    }
    const dir = keyDir();
    chmodSync(join(dir, 'worker-capability.pub'), 0o666);
    expect(() => new ExecutionCapabilityService(dir).issue({
      purpose: 'worker', role: 'user', botName: 'pm-codex', chatId: 'chat-1',
    })).toThrowError(expect.objectContaining({ code: 'UNSAFE_KEY_PERMISSIONS' }));
  });

  it('rejects a symlinked key directory before mutating its target', () => {
    const parent = mkdtempSync(join(tmpdir(), 'metabot-execution-symlink-dir-'));
    dirs.push(parent);
    const target = join(parent, 'target');
    const link = join(parent, 'keys');
    mkdirSync(target, { mode: 0o755 });
    chmodSync(target, 0o755);
    symlinkSync(target, link, 'dir');

    expect(() => provisionExecutionKeyPairs(link)).toThrowError(
      expect.objectContaining({ code: 'UNSAFE_KEY_NODE_TYPE' }),
    );
    expect(lstatSync(target).mode & 0o777).toBe(0o755);
    expect(inspectExecutionKeyDirectory(link)).toMatchObject({
      ok: false,
      directory: { isSymlink: true, nodeType: 'symbolic-link', nodeTypeOk: false },
    });
  });

  it('does not silently repair an existing permissive key directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-execution-permissive-dir-'));
    dirs.push(dir);
    chmodSync(dir, 0o755);

    expect(() => provisionExecutionKeyPairs(dir)).toThrowError(
      expect.objectContaining({ code: 'UNSAFE_KEY_PERMISSIONS' }),
    );
    expect(lstatSync(dir).mode & 0o777).toBe(0o755);
  });

  it('rejects symlinked and non-regular current or previous key nodes', () => {
    const symlinked = keyDir();
    const privatePath = join(symlinked, 'worker-capability.key');
    const privateTarget = join(symlinked, 'worker-capability.key.real');
    renameSync(privatePath, privateTarget);
    symlinkSync(privateTarget, privatePath);
    expect(() => provisionExecutionKeyPairs(symlinked)).toThrowError(
      expect.objectContaining({ code: 'UNSAFE_KEY_NODE_TYPE' }),
    );
    expect(() => new ExecutionCapabilityService(symlinked).issue({
      purpose: 'worker', role: 'pm', botName: 'pm-codex', chatId: 'chat-1',
    })).toThrowError(expect.objectContaining({ code: 'UNSAFE_KEY_NODE_TYPE' }));
    expect(inspectExecutionKeyDirectory(symlinked).pairs[0].privateKey).toMatchObject({
      isSymlink: true,
      nodeType: 'symbolic-link',
      nodeTypeOk: false,
    });

    const nonRegular = keyDir();
    const publicPath = join(nonRegular, 'worker-callback.pub');
    unlinkSync(publicPath);
    mkdirSync(publicPath, { mode: 0o700 });
    expect(() => provisionExecutionKeyPairs(nonRegular)).toThrowError(
      expect.objectContaining({ code: 'UNSAFE_KEY_NODE_TYPE' }),
    );
    expect(inspectExecutionKeyDirectory(nonRegular).pairs[1].publicKey).toMatchObject({
      nodeType: 'directory',
      nodeTypeOk: false,
    });

    const previousSymlink = keyDir();
    const previousToken = new ExecutionCapabilityService(previousSymlink).issue({
      purpose: 'worker', role: 'pm', botName: 'pm-codex', chatId: 'chat-1',
    });
    symlinkSync(
      join(previousSymlink, 'worker-capability.pub'),
      join(previousSymlink, 'worker-capability.pub.prev'),
    );
    expect(() => new ExecutionCapabilityService(previousSymlink).verify(previousToken, {
      purpose: 'worker', botName: 'pm-codex', chatId: 'chat-1',
    })).toThrowError(expect.objectContaining({ code: 'UNSAFE_KEY_NODE_TYPE' }));
    expect(() => provisionExecutionKeyPairs(previousSymlink)).toThrowError(
      expect.objectContaining({ code: 'UNSAFE_KEY_NODE_TYPE' }),
    );
  });

  it('keeps Worker, callback, and W01-HMAC formats purpose-separated and enforces expiry', () => {
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
  });

  it('enforces the 200/500 execution-principal wire limits before mint and during verification', () => {
    const dir = keyDir();
    const service = new ExecutionCapabilityService(dir);
    const botName = 'b'.repeat(EXECUTION_PRINCIPAL_BOT_NAME_MAX_LENGTH);
    const chatId = 'c'.repeat(EXECUTION_PRINCIPAL_CHAT_ID_MAX_LENGTH);
    const token = service.issue({
      purpose: 'worker', role: 'pm', botName, chatId, ttlMs: 60_000,
    }, 10_000);

    expect(service.verify(token, {
      purpose: 'worker', botName, chatId, now: 10_001,
    })).toMatchObject({ botName, chatId });

    const unavailableKeys = new ExecutionCapabilityService(join(dir, 'not-provisioned'));
    for (const input of [
      { botName: `${botName}x`, chatId },
      { botName, chatId: `${chatId}x` },
    ]) {
      expect(() => unavailableKeys.issue({
        purpose: 'worker', role: 'pm', ...input,
      })).toThrowError(expect.objectContaining({ code: 'INVALID_CLAIMS' }));
    }

    for (const claims of [
      { botName: `${botName}x`, chatId: 'chat-ok' },
      { botName: 'bot-ok', chatId: `${chatId}x` },
    ]) {
      const forged = signCapabilityClaims(dir, {
        v: 1,
        purpose: 'worker',
        role: 'pm',
        ...claims,
        exp: 20_000,
      });
      expect(() => service.verify(forged, {
        purpose: 'worker', botName: 'bot-ok', chatId: 'chat-ok', now: 10_001,
      })).toThrowError(expect.objectContaining({ code: 'INVALID_CLAIMS' }));
    }
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
