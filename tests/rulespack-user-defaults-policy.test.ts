import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeRule, type RuleInputV1 } from '@metabot/rulespack';
import { MetaBotRulesPackRuntime } from '@metabot/rulespack-adapter';

const temporary: string[] = [];
const logger = { debug() {}, info() {}, warn() {}, error() {} };

afterEach(() => {
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('personal RulesPack defaults', () => {
  it('selects the three global user defaults for every configured bot identity', async () => {
    const document = JSON.parse(fs.readFileSync(
      path.resolve('config/rulespack/user-defaults.rules.json'),
      'utf8',
    )) as { schemaVersion: number; revision: string; rules: RuleInputV1[] };
    expect(document.schemaVersion).toBe(1);
    expect(document.rules.map((rule) => normalizeRule(rule))).toHaveLength(3);
    expect(document.rules.map((rule) => rule.id)).toEqual([
      'user.latex-report-pdf-default',
      'user.language-defaults',
      'user.plain-language',
    ]);
    expect(document.rules.every((rule) =>
      rule.scope === 'global' && rule.binding === undefined && Object.keys(rule.targets).length === 0
    )).toBe(true);
    expect(document.revision).toBe('user-defaults-2026-08-28.1');
    expect(document.rules.find((rule) => rule.id === 'user.language-defaults')).toMatchObject({
      version: '1.1.0',
      text: 'Use English when conversing with the user and for user-facing deliverables by default. Use another language only when the user explicitly requests it.',
      metadata: {
        conversationLanguage: 'en',
        documentDefaultLanguage: 'en',
        deliverableDefaultLanguage: 'en',
        supersedesVersion: '1.0.0',
      },
    });

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rulespack-user-defaults-'));
    temporary.push(directory);
    const runtime = new MetaBotRulesPackRuntime({
      mode: 'shadow',
      hostId: 'test-host',
      dbPath: path.join(directory, 'rules.sqlite'),
      configRules: {
        id: 'personal-user-defaults',
        revision: document.revision,
        required: true,
        rules: document.rules,
      },
    }, logger);
    try {
      for (const botName of ['admin', 'pm', 'secretary', 'admin-savio', 'pm-savio', 'secretary-savio']) {
        const result = await runtime.explain({
          botName,
          chatId: `chat-${botName}`,
          roles: ['user'],
          cwd: directory,
          tools: [],
          dataClasses: ['chat'],
          outputTypes: ['text'],
        });
        expect(result.pack.rules.map((rule) => rule.id)).toEqual([
          'user.latex-report-pdf-default',
          'user.language-defaults',
          'user.plain-language',
        ]);
      }
    } finally {
      runtime.close();
    }
  });
});
