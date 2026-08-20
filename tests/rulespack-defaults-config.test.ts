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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-rulespack-defaults-'));
  temporary.push(directory);
  const file = path.join(directory, 'bots.json');
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

const defaults = {
  policy: 'required',
  config: {
    mode: 'shadow',
    hostId: 'imac',
    dbPath: '/tmp/rulespack/{surface}-{bot}.sqlite',
    configRules: { id: 'defaults', revision: '1', required: true, rules: [] },
  },
};

describe('RulesPack multi-bot defaults', () => {
  it('applies to current and future Codex bots on every configured platform', () => {
    vi.stubEnv('BOTS_CONFIG', configFile({
      rulesPackDefaults: defaults,
      feishuBots: [{
        name: 'feishu', engine: 'codex', feishuAppId: 'id', feishuAppSecret: 'secret', defaultWorkingDirectory: '.',
      }],
      telegramBots: [{ name: 'telegram', engine: 'codex', telegramBotToken: 'token', defaultWorkingDirectory: '.' }],
      webBots: [{ name: 'web', engine: 'codex', defaultWorkingDirectory: '.' }],
      wechatBots: [{ name: 'wechat', engine: 'codex', wechatBotToken: 'token', defaultWorkingDirectory: '.' }],
      slackBots: [{
        name: 'slack', engine: 'codex', slackBotToken: 'token', slackSigningSecret: 'secret', defaultWorkingDirectory: '.',
      }],
    }));

    const loaded = loadAppConfig();
    const bots = [
      ...loaded.feishuBots,
      ...loaded.telegramBots,
      ...loaded.webBots,
      ...loaded.wechatBots,
      ...loaded.slackBots,
    ];
    expect(bots.map((bot) => bot.name)).toEqual(['feishu', 'telegram', 'web', 'wechat', 'slack']);
    expect(bots.every((bot) => bot.rulesPackPolicy?.state === 'inherited')).toBe(true);
    expect(new Set(bots.map((bot) => bot.rulesPack?.dbPath)).size).toBe(5);
    expect(bots.map((bot) => bot.rulesPack?.dbPath)).toContain('/tmp/rulespack/bridge-web.sqlite');
  });

  it('keeps Claude and Kimi visibly unsupported without creating runtimes', () => {
    vi.stubEnv('BOTS_CONFIG', configFile({
      rulesPackDefaults: defaults,
      webBots: [
        { name: 'claude', engine: 'claude', defaultWorkingDirectory: '.' },
        { name: 'kimi', engine: 'kimi', defaultWorkingDirectory: '.' },
      ],
    }));
    const loaded = loadAppConfig();
    expect(loaded.webBots.map((bot) => bot.rulesPackPolicy?.state)).toEqual(['unsupported', 'unsupported']);
    expect(loaded.webBots.every((bot) => bot.rulesPack === undefined)).toBe(true);
  });

  it('preserves legacy per-bot RulesPack configuration without shared defaults', () => {
    vi.stubEnv('BOTS_CONFIG', configFile({
      webBots: [{
        name: 'legacy',
        engine: 'codex',
        defaultWorkingDirectory: '.',
        rulesPack: { mode: 'shadow', dbPath: '/tmp/legacy-rules.sqlite' },
      }],
    }));
    const [bot] = loadAppConfig().webBots;
    expect(bot.rulesPackPolicy).toEqual({ state: 'overridden', required: false });
    expect(bot.rulesPack?.dbPath).toBe('/tmp/legacy-rules.sqlite');
  });

  it('rejects cross-platform and case-insensitive bot-name collisions before DB creation', () => {
    vi.stubEnv('BOTS_CONFIG', configFile({
      rulesPackDefaults: defaults,
      feishuBots: [{
        name: 'Admin', engine: 'codex', feishuAppId: 'id', feishuAppSecret: 'secret', defaultWorkingDirectory: '.',
      }],
      webBots: [{ name: 'admin', engine: 'codex', defaultWorkingDirectory: '.' }],
    }));
    expect(() => loadAppConfig()).toThrow('globally unique ignoring case');
  });
});
