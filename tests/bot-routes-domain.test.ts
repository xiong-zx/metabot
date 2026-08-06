import * as fs from 'node:fs';
import type * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotRegistry } from '../src/api/bot-registry.js';
import { handleBotRoutes } from '../src/api/routes/bot-routes.js';
import type { RouteContext } from '../src/api/routes/types.js';

let tempDir: string;
let configPath: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-bot-routes-domain-'));
  configPath = path.join(tempDir, 'bots.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      feishuBots: [
        {
          name: 'feishu-bot',
          feishuAppId: 'cli_test',
          feishuAppSecret: 'test-only',
          feishuDomain: 'feishu',
          defaultWorkingDirectory: tempDir,
        },
      ],
      telegramBots: [
        {
          name: 'telegram-bot',
          telegramBotToken: 'test-only',
          defaultWorkingDirectory: tempDir,
        },
      ],
    }),
  );
});

afterEach(() => fs.rmSync(tempDir, { recursive: true, force: true }));

function request(body: Record<string, unknown>): http.IncomingMessage {
  return Readable.from([Buffer.from(JSON.stringify(body))]) as http.IncomingMessage;
}

function response(): {
  res: http.ServerResponse;
  output: { status: number; body?: Record<string, unknown> };
} {
  const output: { status: number; body?: Record<string, unknown> } = { status: 0 };
  const res = {
    writeHead: vi.fn((status: number) => {
      output.status = status;
      return res;
    }),
    end: vi.fn((body?: string) => {
      if (body) output.body = JSON.parse(body) as Record<string, unknown>;
      return res;
    }),
  } as unknown as http.ServerResponse;
  return { res, output };
}

function context(): RouteContext {
  return {
    registry: new BotRegistry(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    botsConfigPath: configPath,
    ws: {},
  } as unknown as RouteContext;
}

describe('bot update Feishu/Lark domain validation', () => {
  it('rejects an invalid domain on a Feishu bot without changing its config', async () => {
    const { res, output } = response();

    const handled = await handleBotRoutes(
      context(),
      request({ feishuDomain: 'global' }),
      res,
      'PUT',
      '/api/bots/feishu-bot',
    );

    expect(handled).toBe(true);
    expect(output).toEqual({
      status: 400,
      body: { error: 'feishuDomain must be "feishu" or "lark"' },
    });
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.feishuBots[0].feishuDomain).toBe('feishu');
  });

  it('rejects feishuDomain on a non-Feishu bot instead of persisting a junk field', async () => {
    const { res, output } = response();

    const handled = await handleBotRoutes(
      context(),
      request({ feishuDomain: 'lark' }),
      res,
      'PUT',
      '/api/bots/telegram-bot',
    );

    expect(handled).toBe(true);
    expect(output).toEqual({
      status: 400,
      body: { error: 'feishuDomain can only be set on Feishu bots' },
    });
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.telegramBots[0]).not.toHaveProperty('feishuDomain');
  });
});
