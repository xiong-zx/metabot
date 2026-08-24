import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadAppConfig } from '../src/config.js';

const ACTIVE_SECRET = 'startup-peer-key-000000000000000000000000001';
const tempDirs: string[] = [];

function configPath(auth: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-peer-config-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'bots.json');
  fs.writeFileSync(file, JSON.stringify({
    webBots: [{ name: 'local-bot', defaultWorkingDirectory: dir }],
    peers: [{ name: 'remote', url: 'http://127.0.0.1:19110', auth }],
  }));
  return file;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('startup peer auth configuration', () => {
  it.each([
    ['string source scope', { allowedSourceBots: 'trusted-bot' }],
    ['mixed target scope', { allowedTargetBots: ['target-bot', 42] }],
    ['string revoked keys', { revokedKeyIds: 'old-key' }],
    ['non-array rotation keys', { acceptKeys: 'old-key' }],
  ])('rejects %s instead of falling through to substring matching', (_label, invalid) => {
    vi.stubEnv('BOTS_CONFIG', configPath({ keyId: 'active-key', secret: ACTIVE_SECRET, ...invalid }));
    vi.stubEnv('METABOT_API_PORT', '');
    expect(() => loadAppConfig()).toThrow(/Invalid scoped peer auth/);
  });

  it('accepts validated scope arrays and bounded rotation keys', () => {
    vi.stubEnv('BOTS_CONFIG', configPath({
      keyId: 'active-key',
      secret: ACTIVE_SECRET,
      acceptKeys: [{
        keyId: 'old-key',
        secret: 'old-startup-peer-key-0000000000000000000000002',
        acceptUntil: '2026-08-24T00:00:00.000Z',
      }],
      revokedKeyIds: ['revoked-key'],
      allowedSourceBots: ['trusted-bot'],
      allowedTargetBots: ['local-bot'],
    }));
    vi.stubEnv('METABOT_API_PORT', '');
    expect(loadAppConfig().peers[0].auth).toMatchObject({
      keyId: 'active-key',
      allowedSourceBots: ['trusted-bot'],
      allowedTargetBots: ['local-bot'],
    });
  });
});
