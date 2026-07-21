import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { loadMcpServersWithApiContext } from '../src/engines/claude/executor.js';

function withEnv<T>(patch: Record<string, string | undefined>, fn: () => T): T {
  const original: Record<string, string | undefined> = {};
  for (const key of Object.keys(patch)) {
    original[key] = process.env[key];
    if (patch[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = patch[key];
    }
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe('loadMcpServersWithApiContext', () => {
  it('adds a default worker-manager MCP server when Claude settings are absent', () => {
    const home = mkdtempSync(join(tmpdir(), 'metabot-claude-mcp-home-'));
    const servers = withEnv({
      HOME: home,
      METABOT_API_PORT: '9191',
      METABOT_API_SECRET: 'secret-for-test',
    }, () => loadMcpServersWithApiContext({ botName: 'pm-claude', chatId: 'oc_test' }) as any);

    expect(servers['worker-manager']).toBeTruthy();
    expect(servers['worker-manager'].command).toBe(process.execPath);
    expect(servers['worker-manager'].args.join(' ')).toContain('worker-manager-mcp');
    expect(servers['worker-manager'].env).toMatchObject({
      METABOT_API_URL: 'http://localhost:9191',
      METABOT_API_SECRET: 'secret-for-test',
      METABOT_BOT_NAME: 'pm-claude',
      METABOT_CHAT_ID: 'oc_test',
    });
  });

  it('preserves a configured worker-manager server and injects API context', () => {
    const home = mkdtempSync(join(tmpdir(), 'metabot-claude-mcp-home-'));
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({
      mcpServers: {
        'worker-manager': {
          command: 'custom-worker-mcp',
          args: ['--stdio'],
          env: { EXISTING: '1' },
        },
      },
    }));

    const servers = withEnv({
      HOME: home,
      METABOT_API_URL: 'http://127.0.0.1:9100',
      METABOT_API_SECRET: undefined,
      API_SECRET: 'api-secret-for-test',
    }, () => loadMcpServersWithApiContext({ botName: 'pm-claude', chatId: 'oc_test' }) as any);

    expect(servers['worker-manager']).toMatchObject({
      command: 'custom-worker-mcp',
      args: ['--stdio'],
    });
    expect(servers['worker-manager'].env).toMatchObject({
      EXISTING: '1',
      METABOT_API_URL: 'http://127.0.0.1:9100',
      METABOT_API_SECRET: 'api-secret-for-test',
      METABOT_BOT_NAME: 'pm-claude',
      METABOT_CHAT_ID: 'oc_test',
    });
  });
});
