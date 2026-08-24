import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadAppConfig } from '../src/config.js';

const temporary: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function configFile(value: unknown): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-artifact-config-'));
  temporary.push(directory);
  const file = path.join(directory, 'bots.json');
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

describe('artifact delivery bot configuration', () => {
  it('normalizes exact project/chat bindings for a producing bot', () => {
    vi.stubEnv(
      'BOTS_CONFIG',
      configFile({
        webBots: [
          {
            name: 'publisher',
            engine: 'codex',
            defaultWorkingDirectory: '/srv/workspaces',
            artifactDelivery: {
              mode: 'enforce',
              projects: [{ projectId: 'aam', root: '/srv/workspaces/projects/aam', chatIds: ['chat-aam'] }],
            },
          },
        ],
      }),
    );
    const [bot] = loadAppConfig().webBots;
    expect(bot.artifactDelivery).toEqual({
      mode: 'enforce',
      projects: [{ projectId: 'aam', root: '/srv/workspaces/projects/aam', chatIds: ['chat-aam'] }],
    });
  });

  it('rejects one chat bound to two publication roots', () => {
    vi.stubEnv(
      'BOTS_CONFIG',
      configFile({
        webBots: [
          {
            name: 'publisher',
            engine: 'codex',
            defaultWorkingDirectory: '/srv/workspaces',
            artifactDelivery: {
              mode: 'enforce',
              projects: [
                { projectId: 'aam', root: '/srv/workspaces/projects/aam', chatIds: ['same'] },
                { projectId: 'noise-llm', root: '/srv/workspaces/projects/noise-llm', chatIds: ['same'] },
              ],
            },
          },
        ],
      }),
    );
    expect(() => loadAppConfig()).toThrow(/unique/u);
  });
});
