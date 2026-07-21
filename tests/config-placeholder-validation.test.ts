import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { loadAppConfig } from '../src/config.js';

function withBotsConfig<T>(configPath: string, fn: () => T): T {
  const previous = process.env.BOTS_CONFIG;
  process.env.BOTS_CONFIG = configPath;
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env.BOTS_CONFIG;
    } else {
      process.env.BOTS_CONFIG = previous;
    }
  }
}

describe('bots.json placeholder validation', () => {
  it('loads the checked-in safe example config', () => {
    const config = withBotsConfig('bots.example.json', () => loadAppConfig());
    expect(config.webBots.map((bot) => bot.name)).toContain('local-web');
    expect(config.feishuBots).toHaveLength(0);
    expect(config.telegramBots).toHaveLength(0);
    expect(config.wechatBots).toHaveLength(0);
  });

  it('rejects known placeholder Feishu credentials before startup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-config-placeholder-'));
    const configPath = join(dir, 'bots.json');
    writeFileSync(configPath, JSON.stringify({
      feishuBots: [
        {
          name: 'bad-feishu',
          feishuAppId: 'cli_xxx',
          feishuAppSecret: 'secret1',
          defaultWorkingDirectory: '.',
        },
      ],
    }));

    expect(() => withBotsConfig(configPath, () => loadAppConfig()))
      .toThrow(/feishuBots\[0\]\.feishuAppId.*placeholder/);
  });
});
