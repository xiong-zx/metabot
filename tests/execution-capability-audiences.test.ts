import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  assertDistinctKeyMaterial,
  ExecutionCapabilityError,
  ExecutionCapabilityService,
  inspectExecutionKeyDirectory,
  provisionExecutionKeyPairs,
  requiredCapabilityAudience,
  type ExecutionCapabilityClaims,
} from '../src/services/execution-capabilities.js';
import {
  assertDistinctMcpServers,
  EXECUTION_MCP_SERVERS,
} from '../src/services/mcp-registry.js';
import {
  leaseCapabilityFile,
  resolveCapabilityLeaseDirectory,
  sweepExpiredCapabilityLeases,
} from '../src/services/capability-lease.js';
import {
  issueStandaloneCapabilityLease,
  standaloneEligibleAudiences,
  standaloneIssuerStatus,
  STANDALONE_CAPABILITY_MAX_TTL_MS,
} from '../src/services/standalone-capability-issuer.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function keyDir(): string {
  const dir = scratch('metabot-audience-keys-');
  chmodSync(dir, 0o700);
  provisionExecutionKeyPairs(dir);
  return dir;
}

function runtimeRoot(): string {
  return scratch('metabot-audience-runtime-');
}

function claimsOf(token: string): ExecutionCapabilityClaims & { aud?: string } {
  return JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof ExecutionCapabilityError ? error.code : `unexpected:${String(error)}`;
  }
  return 'no-error';
}

describe('capability audience table', () => {
  it('registers distinct ids and audiences', () => {
    expect(() => assertDistinctMcpServers()).not.toThrow();
    expect(EXECUTION_MCP_SERVERS.map((entry) => entry.id)).toEqual(['worker', 'arc', 'metaclaw']);
  });

  it('rejects a table that reuses an id or an audience', () => {
    expect(() =>
      assertDistinctMcpServers([
        EXECUTION_MCP_SERVERS[1]!,
        { ...EXECUTION_MCP_SERVERS[2]!, audience: 'arc' },
      ]),
    ).toThrowError(/reuses audience "arc"/);
    expect(() =>
      assertDistinctMcpServers([{ ...EXECUTION_MCP_SERVERS[2]!, id: '' }]),
    ).toThrowError(/reuses|non-empty|id/i);
  });

  it('derives key namespaces without renumbering the existing worker and ARC pairs', () => {
    expect(inspectExecutionKeyDirectory(keyDir()).pairs.map((pair) => pair.name)).toEqual([
      'worker-capability',
      'arc-capability',
      'metaclaw-capability',
      'worker-callback',
      'arc-callback',
    ]);
  });

  it('provisions a metaclaw capability keypair and no metaclaw callback keypair', () => {
    const dir = keyDir();
    const files = readdirSync(dir).sort();
    expect(files).toContain('metaclaw-capability.key');
    expect(files).toContain('metaclaw-capability.pub');
    expect(files).not.toContain('metaclaw-callback.key');
    expect(lstatSync(join(dir, 'metaclaw-capability.key')).mode & 0o777).toBe(0o600);
    expect(inspectExecutionKeyDirectory(dir).ok).toBe(true);
  });
});

describe('signed audience claim', () => {
  it('leaves Worker on v2.1 while ARC and MetaClaw require signed audiences', () => {
    const service = new ExecutionCapabilityService(keyDir());
    expect(requiredCapabilityAudience('worker')).toBeUndefined();
    const worker = claimsOf(service.issue({ purpose: 'worker', role: 'pm', botName: 'pm-codex', chatId: 'chat-1' }, 10_000));
    expect(Object.keys(worker).sort()).toEqual(['botName', 'chatId', 'exp', 'purpose', 'role', 'v']);
    expect(requiredCapabilityAudience('arc')).toBe('arc');
    expect(claimsOf(service.issue({ purpose: 'arc', role: 'pm', botName: 'pm-codex', chatId: 'chat-1' }, 10_000)).aud).toBe('arc');
  });

  it('mints and requires aud=metaclaw', () => {
    const service = new ExecutionCapabilityService(keyDir());
    expect(requiredCapabilityAudience('metaclaw')).toBe('metaclaw');
    const token = service.issue({ purpose: 'metaclaw', role: 'user', botName: 'pm-codex', chatId: 'chat-1' }, 10_000);
    expect(claimsOf(token).aud).toBe('metaclaw');
    expect(service.verify(token, { purpose: 'metaclaw', botName: 'pm-codex', chatId: 'chat-1', now: 10_500 }))
      .toMatchObject({ purpose: 'metaclaw', aud: 'metaclaw', role: 'user' });
  });

  it('refuses a metaclaw token whose audience claim was stripped, before scope is even considered', () => {
    const dir = keyDir();
    const service = new ExecutionCapabilityService(dir);
    const forged = signWith(dir, 'metaclaw-capability', {
      v: 1,
      purpose: 'metaclaw',
      role: 'user',
      botName: 'pm-codex',
      chatId: 'chat-1',
      exp: 20_000,
    });
    expect(
      codeOf(() => service.verify(forged, { purpose: 'metaclaw', botName: 'pm-codex', chatId: 'chat-1', now: 10_000 })),
    ).toBe('CAPABILITY_AUDIENCE_MISMATCH');

    // Same missing audience, and also a scope mismatch: the audience check
    // must be the one that fires.
    expect(
      codeOf(() => service.verify(forged, { purpose: 'metaclaw', botName: 'other-bot', chatId: 'chat-9', now: 10_000 })),
    ).toBe('CAPABILITY_AUDIENCE_MISMATCH');
  });

  it('refuses an audience smuggled onto a v2.1 purpose', () => {
    const dir = keyDir();
    const service = new ExecutionCapabilityService(dir);
    const forged = signWith(dir, 'worker-capability', {
      v: 1,
      purpose: 'worker',
      aud: 'metaclaw',
      role: 'pm',
      botName: 'pm-codex',
      chatId: 'chat-1',
      exp: 20_000,
    } as ExecutionCapabilityClaims);
    expect(
      codeOf(() => service.verify(forged, { purpose: 'worker', botName: 'pm-codex', chatId: 'chat-1', now: 10_000 })),
    ).toBe('CAPABILITY_AUDIENCE_MISMATCH');
  });

  it('refuses cross-audience reuse in both directions', () => {
    const service = new ExecutionCapabilityService(keyDir());
    const metaclaw = service.issue(
      { purpose: 'metaclaw', role: 'user', botName: 'pm-codex', chatId: 'chat-1' },
      10_000,
    );
    const arc = service.issue({ purpose: 'arc', role: 'pm', botName: 'pm-codex', chatId: 'chat-1' }, 10_000);

    for (const purpose of ['worker', 'arc'] as const) {
      expect(
        codeOf(() => service.verify(metaclaw, { purpose, botName: 'pm-codex', chatId: 'chat-1', now: 10_500 })),
      ).toBe('INVALID_SIGNATURE');
    }
    expect(
      codeOf(() => service.verify(arc, { purpose: 'metaclaw', botName: 'pm-codex', chatId: 'chat-1', now: 10_500 })),
    ).toBe('INVALID_SIGNATURE');
  });

  it('rejects an unregistered purpose instead of defaulting it', () => {
    const service = new ExecutionCapabilityService(keyDir());
    expect(codeOf(() => requiredCapabilityAudience('nope' as never))).toBe('UNKNOWN_PURPOSE');
    expect(
      codeOf(() => service.issue({ purpose: 'nope' as never, role: 'pm', botName: 'b', chatId: 'c' })),
    ).toBe('UNKNOWN_PURPOSE');
  });

  it('mints a local lifecycle admin capability with the audience its purpose requires', () => {
    const service = new ExecutionCapabilityService(keyDir());
    expect(claimsOf(service.issueLocalLifecycleAdmin('metaclaw', 60_000, 10_000)).aud).toBe('metaclaw');
    expect(claimsOf(service.issueLocalLifecycleAdmin('arc', 60_000, 10_000)).aud).toBe('arc');
  });
});

describe('cross-audience key reuse guard', () => {
  it('accepts a freshly provisioned directory', () => {
    expect(() => assertDistinctKeyMaterial(keyDir())).not.toThrow();
  });

  it('refuses two audiences sharing verification material, whitespace differences included', () => {
    const dir = keyDir();
    const shared = readFileSync(join(dir, 'arc-capability.pub'), 'utf8');
    writeFileSync(join(dir, 'metaclaw-capability.pub'), `${shared.trimEnd()}\n\n`, { mode: 0o600 });
    chmodSync(join(dir, 'metaclaw-capability.pub'), 0o600);
    expect(codeOf(() => assertDistinctKeyMaterial(dir))).toBe('CROSS_AUDIENCE_KEY_REUSE');
  });

  it('refuses a previous key that repeats another audience current key', () => {
    const dir = keyDir();
    const shared = readFileSync(join(dir, 'worker-capability.pub'), 'utf8');
    writeFileSync(join(dir, 'metaclaw-capability.pub.prev'), shared, { mode: 0o600 });
    chmodSync(join(dir, 'metaclaw-capability.pub.prev'), 0o600);
    expect(codeOf(() => assertDistinctKeyMaterial(dir))).toBe('CROSS_AUDIENCE_KEY_REUSE');
  });

  it('permits an independent previous key so rotation still works per audience', () => {
    const dir = keyDir();
    const { publicKey } = generateKeyPairSync('ed25519');
    writeFileSync(join(dir, 'metaclaw-capability.pub.prev'), publicKey.export({ type: 'spki', format: 'pem' }), {
      mode: 0o600,
    });
    chmodSync(join(dir, 'metaclaw-capability.pub.prev'), 0o600);
    expect(() => assertDistinctKeyMaterial(dir)).not.toThrow();
  });
});

describe('per-turn capability leases', () => {
  it('writes a 0600 regular file inside the runtime root', () => {
    const root = runtimeRoot();
    const lease = leaseCapabilityFile({
      runtimeRoot: root,
      audience: 'metaclaw',
      scope: 'pm-codex/chat-1',
      token: 'payload.signature',
      expiresAt: 20_000,
    });
    expect(lease.path.startsWith(resolveCapabilityLeaseDirectory(root))).toBe(true);
    expect(lstatSync(lease.path).mode & 0o777).toBe(0o600);
    expect(readFileSync(lease.path, 'utf8')).toBe('payload.signature');
    expect(lstatSync(resolveCapabilityLeaseDirectory(root)).mode & 0o777).toBe(0o700);
  });

  it('gives concurrent same-scope turns distinct nonce paths that cannot overwrite each other', () => {
    const root = runtimeRoot();
    const leases = Array.from({ length: 8 }, (_unused, index) =>
      leaseCapabilityFile({
        runtimeRoot: root,
        audience: 'metaclaw',
        scope: 'pm-codex/chat-1',
        token: `token-${index}`,
        expiresAt: 20_000,
      }),
    );
    expect(new Set(leases.map((lease) => lease.path)).size).toBe(8);
    for (const [index, lease] of leases.entries()) {
      expect(readFileSync(lease.path, 'utf8')).toBe(`token-${index}`);
    }
  });

  it('hashes principal scope out of every on-disk lease name', () => {
    const lease = leaseCapabilityFile({
      runtimeRoot: runtimeRoot(),
      audience: 'metaclaw',
      scope: 'pm-secret-bot/chat-private-identifier',
      token: 'payload.signature',
      expiresAt: 20_000,
    });
    const name = lease.path.split('/').pop()!;
    expect(name).toMatch(/^scope-[0-9a-f]{24}-metaclaw-20000-/);
    expect(name).not.toContain('secret');
    expect(name).not.toContain('private');
  });

  it('releases one entry without disturbing another, and is idempotent', () => {
    const root = runtimeRoot();
    const first = leaseCapabilityFile({
      runtimeRoot: root, audience: 'metaclaw', scope: 's', token: 'a', expiresAt: 20_000,
    });
    const second = leaseCapabilityFile({
      runtimeRoot: root, audience: 'arc', scope: 's', token: 'b', expiresAt: 20_000,
    });
    first.release();
    first.release();
    expect(() => lstatSync(first.path)).toThrow();
    expect(readFileSync(second.path, 'utf8')).toBe('b');
  });

  it('refuses an empty capability, an invalid expiry, an unsafe audience, and a relative root', () => {
    const root = runtimeRoot();
    const base = { runtimeRoot: root, audience: 'metaclaw', scope: 's', token: 't', expiresAt: 20_000 };
    expect(() => leaseCapabilityFile({ ...base, token: '' })).toThrowError(/empty capability/);
    expect(() => leaseCapabilityFile({ ...base, expiresAt: 0 })).toThrowError(/positive integer/);
    expect(() => leaseCapabilityFile({ ...base, audience: '../escape' })).toThrowError(/safe path segment/);
    expect(() => leaseCapabilityFile({ ...base, runtimeRoot: 'relative' })).toThrowError(/must be absolute/);
  });

  it('sweeps expired leftovers at startup and retains everything else', () => {
    const root = runtimeRoot();
    const expired = leaseCapabilityFile({
      runtimeRoot: root, audience: 'metaclaw', scope: 's', token: 'stale', expiresAt: 10_000,
    });
    const live = leaseCapabilityFile({
      runtimeRoot: root, audience: 'metaclaw', scope: 's', token: 'fresh', expiresAt: 90_000,
    });
    const directory = resolveCapabilityLeaseDirectory(root);
    const foreign = join(directory, 'operator-notes.txt');
    writeFileSync(foreign, 'not a lease', { mode: 0o600 });

    const result = sweepExpiredCapabilityLeases(root, { now: 50_000 });

    expect(result.removed).toEqual([expired.path.split('/').pop()]);
    expect(result.retained).toContain(live.path.split('/').pop());
    expect(result.retained).toContain('operator-notes.txt');
    expect(readFileSync(live.path, 'utf8')).toBe('fresh');
    expect(readFileSync(foreign, 'utf8')).toBe('not a lease');
  });

  it('retains a lease-shaped name it cannot parse rather than guessing', () => {
    const root = runtimeRoot();
    const directory = resolveCapabilityLeaseDirectory(root);
    writeFileSync(join(directory, 'unparseable.token'), 'x', { mode: 0o600 });
    const result = sweepExpiredCapabilityLeases(root, { now: 10 ** 12 });
    expect(result.removed).toEqual([]);
    expect(result.retained).toContain('unparseable.token');
  });

  it('never misparses or deletes an ARC materializer lease from the shared directory', () => {
    const root = runtimeRoot();
    const directory = resolveCapabilityLeaseDirectory(root);
    // ARC's materializer owns a different filename grammar. The first UUID
    // group is deliberately numeric: the former positional parser treated it
    // as an expiry and deleted this otherwise live foreign lease.
    const arcLease = 'pm-codex-0123456789abcdef01234567-12345678-1234-4123-8123-123456789abc-arc.token';
    writeFileSync(join(directory, arcLease), 'arc capability', { mode: 0o600 });

    const result = sweepExpiredCapabilityLeases(root, { now: 10 ** 12 });
    expect(result.removed).not.toContain(arcLease);
    expect(result.retained).toContain(arcLease);
    expect(readFileSync(join(directory, arcLease), 'utf8')).toBe('arc capability');
  });

  it('refuses a lease directory that is not a real directory', () => {
    const root = runtimeRoot();
    mkdirSync(join(root, 'data'), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, 'data', 'mcp-capabilities'), 'not a directory', { mode: 0o600 });
    expect(() => resolveCapabilityLeaseDirectory(root)).toThrow();
  });
});

describe('standalone capability acquisition contract', () => {
  const request = (root: string) => ({
    purpose: 'metaclaw' as const,
    role: 'user' as const,
    botName: 'pm-codex',
    chatId: 'chat-1',
    runtimeRoot: root,
  });

  it('is disabled by default and states why', () => {
    const status = standaloneIssuerStatus();
    expect(status.enabled).toBe(false);
    expect(status.audiences).toEqual([]);
    expect(status.limitation).toMatch(/not activated/);
    expect(codeOf(() => issueStandaloneCapabilityLease(request(runtimeRoot())))).toBe('STANDALONE_ISSUER_DISABLED');
  });

  it('offers only audiences on the strict claim contract', () => {
    expect(standaloneEligibleAudiences()).toEqual(['metaclaw']);
    expect(standaloneIssuerStatus({ enabled: true }).audiences).toEqual(['metaclaw']);
  });

  it('derives eligibility entirely from descriptor rows', () => {
    expect(standaloneEligibleAudiences([
      {
        ...EXECUTION_MCP_SERVERS[2]!,
        id: 'synthetic', audience: 'synthetic-aud', standaloneEligible: true,
      },
      {
        ...EXECUTION_MCP_SERVERS[2]!,
        id: 'disabled', audience: 'disabled-aud', standaloneEligible: false,
      },
    ])).toEqual(['synthetic-aud']);
  });

  it('returns a leased file path and never the token or the issuer key', () => {
    const root = runtimeRoot();
    const service = new ExecutionCapabilityService(keyDir());
    const grant = issueStandaloneCapabilityLease(request(root), {
      enabled: true,
      service,
      now: () => 100_000,
    });

    expect(Object.keys(grant).sort()).toEqual(['audience', 'capabilityFilePath', 'expiresAt', 'purpose', 'release']);
    expect(grant.audience).toBe('metaclaw');
    expect(grant.expiresAt).toBe(100_000 + 5 * 60 * 1000);
    expect(lstatSync(grant.capabilityFilePath).mode & 0o777).toBe(0o600);

    const leased = readFileSync(grant.capabilityFilePath, 'utf8');
    expect(claimsOf(leased)).toMatchObject({ aud: 'metaclaw', purpose: 'metaclaw', role: 'user' });
    expect(JSON.stringify(grant)).not.toContain(leased.split('.')[1]);
    expect(leased).not.toContain('PRIVATE KEY');

    grant.release();
    expect(() => lstatSync(grant.capabilityFilePath)).toThrow();
  });

  it('refuses a purpose that carries no signed audience', () => {
    const service = new ExecutionCapabilityService(keyDir());
    expect(
      codeOf(() =>
        issueStandaloneCapabilityLease(
          { ...request(runtimeRoot()), purpose: 'worker', role: 'pm' },
          { enabled: true, service },
        ),
      ),
    ).toBe('STANDALONE_AUDIENCE_REQUIRED');
  });

  it('bounds the requested lifetime', () => {
    const service = new ExecutionCapabilityService(keyDir());
    for (const ttlMs of [0, -1, STANDALONE_CAPABILITY_MAX_TTL_MS + 1, 1.5]) {
      expect(
        codeOf(() => issueStandaloneCapabilityLease({ ...request(runtimeRoot()), ttlMs }, { enabled: true, service })),
      ).toBe('INVALID_TTL');
    }
  });
});

function signWith(keysDir: string, prefix: string, claims: ExecutionCapabilityClaims): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = cryptoSign(
    null,
    Buffer.from(payload),
    readFileSync(join(keysDir, `${prefix}.key`), 'utf8'),
  ).toString('base64url');
  return `${payload}.${signature}`;
}
