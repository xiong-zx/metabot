import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAppConfig, parseFeishuDomain } from '../src/config.js';

const ENV_KEYS = [
  'BOTS_CONFIG',
  'FEISHU_APP_ID',
  'FEISHU_APP_SECRET',
  'FEISHU_DOMAIN',
  'FEISHU_SERVICE_APP_ID',
  'FEISHU_SERVICE_APP_SECRET',
  'FEISHU_SERVICE_DOMAIN',
  'TELEGRAM_BOT_TOKEN',
  'WECHAT_BOT_TOKEN',
  'WECHAT_ILINK_ENABLED',
  'CLAUDE_DEFAULT_WORKING_DIRECTORY',
] as const;

const originalEnv = new Map<string, string | undefined>();
let tempDirs: string[] = [];

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originalEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  originalEnv.clear();
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function useBotsConfig(feishuDomain?: unknown): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-domain-config-'));
  tempDirs.push(dir);
  const configPath = path.join(dir, 'bots.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      feishuBots: [
        {
          name: 'domain-test',
          feishuAppId: 'cli_test',
          feishuAppSecret: 'test-only',
          ...(feishuDomain === undefined ? {} : { feishuDomain }),
          defaultWorkingDirectory: dir,
        },
      ],
    }),
  );
  process.env.BOTS_CONFIG = configPath;
}

describe('Feishu/Lark domain configuration', () => {
  it('defaults legacy bot and service configuration to Feishu', () => {
    useBotsConfig();

    const config = loadAppConfig();

    expect(config.feishuBots[0]?.feishu.domain).toBe('feishu');
    expect(config.feishuService?.domain).toBe('feishu');
  });

  it('keeps a fallback Wiki service app on the first bot tenant', () => {
    useBotsConfig('lark');

    const config = loadAppConfig();

    expect(config.feishuBots[0]?.feishu.domain).toBe('lark');
    expect(config.feishuService?.domain).toBe('lark');
  });

  it('supports independent single-bot and dedicated service tenants', () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-domain-env-'));
    tempDirs.push(workDir);
    process.env.FEISHU_APP_ID = 'cli_chat';
    process.env.FEISHU_APP_SECRET = 'test-only';
    process.env.FEISHU_DOMAIN = 'lark';
    process.env.FEISHU_SERVICE_APP_ID = 'cli_wiki';
    process.env.FEISHU_SERVICE_APP_SECRET = 'test-only';
    process.env.FEISHU_SERVICE_DOMAIN = 'feishu';
    process.env.CLAUDE_DEFAULT_WORKING_DIRECTORY = workDir;

    const config = loadAppConfig();

    expect(config.feishuBots[0]?.feishu.domain).toBe('lark');
    expect(config.feishuService?.domain).toBe('feishu');
  });

  it('rejects unknown explicit domains instead of choosing an endpoint', () => {
    expect(() => parseFeishuDomain('Lark')).toThrow('must be "feishu" or "lark"');
    useBotsConfig('global');
    expect(() => loadAppConfig()).toThrow('Feishu bot "domain-test" feishuDomain');
  });
});
