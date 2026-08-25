import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { LocalCapabilityVerifier, readPublicKeyFile } from '../packages/worker-runner-mcp/src/local-auth.js';
import { ExecutionCapabilityService, provisionExecutionKeyPairs } from '../src/services/execution-capabilities.js';

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
});
