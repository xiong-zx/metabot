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

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

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
  const logger = {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: vi.fn(() => logger),
  };
  return {
    registry: new BotRegistry(),
    logger,
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

  it('applies shared RulesPack defaults when a future Web bot is hot-added', async () => {
    const current = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    current.rulesPackDefaults = {
      policy: 'required',
      config: {
        mode: 'shadow',
        hostId: 'imac',
        dbPath: path.join(tempDir, '{surface}-{bot}.sqlite'),
        configRules: { id: 'hot-add', revision: '1', required: true, rules: [] },
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(current));
    const ctx = context();
    const { res, output } = response();
    const handled = await handleBotRoutes(
      ctx,
      request({
        platform: 'web',
        name: 'future-codex',
        engine: 'codex',
        defaultWorkingDirectory: path.join(tempDir, 'future-workspace'),
      }),
      res,
      'POST',
      '/api/bots',
    );
    expect(handled).toBe(true);
    expect(output.status).toBe(201);
    const bot = ctx.registry.get('future-codex');
    expect(bot?.config.rulesPackPolicy).toEqual({ state: 'inherited', required: true });
    expect(bot?.config.rulesPack?.dbPath).toBe(path.join(tempDir, 'bridge-future-codex.sqlite'));
    await bot?.bridge.destroyAsync();
  });

  it('rejects a PUT that would disable required RulesPack without poisoning bots.json', async () => {
    const current = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    current.rulesPackDefaults = {
      policy: 'required',
      config: {
        mode: 'enforce',
        dbPath: path.join(tempDir, '{surface}-{bot}.sqlite'),
        configRules: { id: 'required', revision: '1', required: true, rules: [] },
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(current));
    const before = fs.readFileSync(configPath, 'utf8');
    const { res, output } = response();
    await handleBotRoutes(
      context(), request({ rulesPack: { mode: 'off' } }), res, 'PUT', '/api/bots/feishu-bot',
    );
    expect(output.status).toBe(400);
    expect(output.body?.error).toContain('required RulesPack default mode');
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
  });

  it('preflights a hot-added Web runtime before persisting it', async () => {
    const current = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    current.rulesPackDefaults = {
      policy: 'required',
      config: {
        mode: 'shadow',
        hostId: 'imac',
        dbPath: path.join(tempDir, '{surface}-{bot}.sqlite'),
        metaMemory: { hostRoot: '/wrong-host', paths: ['/wrong-host/rules'], required: true },
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(current));
    const { res, output } = response();
    await handleBotRoutes(
      context(),
      request({
        platform: 'web', name: 'poisoned', engine: 'codex',
        defaultWorkingDirectory: path.join(tempDir, 'poisoned-workspace'),
      }),
      res,
      'POST',
      '/api/bots',
    );
    expect(output.status).toBe(400);
    const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(persisted.webBots).toBeUndefined();
  });

  it('uses METABOT_ENGINE consistently when a hot-added bot omits engine', async () => {
    vi.stubEnv('METABOT_ENGINE', 'claude');
    const current = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    current.rulesPackDefaults = {
      policy: 'required',
      config: { mode: 'shadow', dbPath: path.join(tempDir, '{surface}-{bot}.sqlite') },
    };
    fs.writeFileSync(configPath, JSON.stringify(current));
    const ctx = context();
    const { res, output } = response();
    await handleBotRoutes(
      ctx,
      request({
        platform: 'web', name: 'env-claude',
        defaultWorkingDirectory: path.join(tempDir, 'env-claude-workspace'),
      }),
      res,
      'POST',
      '/api/bots',
    );
    expect(output.status).toBe(201);
    const bot = ctx.registry.get('env-claude');
    expect(bot?.config.rulesPack).toMatchObject({ mode: 'shadow' });
    expect(bot?.config.rulesPackPolicy?.state).toBe('inherited');
    await bot?.bridge.destroyAsync();
  });

  it('rejects an actual reserved RulesPack DB path before PUT persistence', async () => {
    const before = fs.readFileSync(configPath, 'utf8');
    const { res, output } = response();
    await handleBotRoutes(
      context(),
      request({ rulesPack: { mode: 'shadow', dbPath: path.join(tempDir, 'sessions.db') } }),
      res,
      'PUT',
      '/api/bots/feishu-bot',
    );
    expect(output.status).toBe(400);
    expect(output.body?.error).toContain('own SQLite database path');
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
  });
});
