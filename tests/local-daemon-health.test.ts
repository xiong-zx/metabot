import { lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { LocalCapabilityVerifier, readPublicKeyFile } from '../packages/worker-runner-mcp/src/local-auth.js';
import { ExecutionCapabilityService, provisionExecutionKeyPairs } from '../src/services/execution-capabilities.js';
import { provisionArcServiceCapability } from '../src/services/local-daemon-health.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('local daemon lifecycle credentials', () => {
  it('pins the health reader as local admin without broadening engine capability issuance', () => {
    const root = mkdtempSync(join(tmpdir(), 'metabot-daemon-health-'));
    directories.push(root);
    const keys = join(root, 'keys');
    provisionExecutionKeyPairs(keys);
    const service = new ExecutionCapabilityService(keys);
    const token = service.issueLocalLifecycleAdmin('worker', 60_000, Date.now());
    const verified = new LocalCapabilityVerifier([
      readPublicKeyFile(join(keys, 'worker-capability.pub'), 'worker capability'),
    ], 'worker').verify(token);

    expect(verified.principal).toEqual({
      role: 'admin',
      botName: 'metabot-local-lifecycle',
      chatId: 'local:daemon-lifecycle',
    });
    expect(() => service.issue({
      purpose: 'worker',
      role: 'admin' as 'pm',
      botName: 'spoofed-engine-admin',
      chatId: 'chat',
    })).toThrow(/Only pm\/user/);
  });

  it('writes a private stable ARC service capability outside the runtime checkout', () => {
    const root = mkdtempSync(join(tmpdir(), 'metabot-arc-service-'));
    directories.push(root);
    const keys = join(root, 'state', 'keys');
    provisionExecutionKeyPairs(keys);
    const capabilityFile = provisionArcServiceCapability({
      METABOT_KEYS_DIR: keys,
      METABOT_STATE_DIR: join(root, 'state'),
    });
    const stat = lstatSync(capabilityFile);
    const token = readFileSync(capabilityFile, 'utf8').trim();
    const verified = new LocalCapabilityVerifier([
      readPublicKeyFile(join(keys, 'worker-capability.pub'), 'worker capability'),
    ], 'worker').verify(token);

    expect(capabilityFile).toBe(join(keys, 'arc-service.cap'));
    expect(stat.isFile()).toBe(true);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(verified.principal).toEqual({ role: 'pm', botName: 'arc-service', chatId: 'local:arc-service' });
  });
});
