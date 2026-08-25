import { describe, expect, it } from 'vitest';
import { resolveRulesPackBotConfig, type RulesPackDefaultsConfig } from '../src/config.js';

const defaults: RulesPackDefaultsConfig = {
  policy: 'required',
  config: {
    mode: 'shadow',
    hostId: 'imac',
    dbPath: '/tmp/rulespack/{surface}-{bot}.sqlite',
    metaMemory: {
      id: 'imac-rules',
      hostRoot: '/imac',
      paths: ['/imac/rules/codex/metabot-development'],
      required: true,
    },
    projectBindings: [
      { projectId: 'metabot', root: '/srv/metabot' },
      { projectId: 'metabot', root: '/srv/metabot-worktrees' },
    ],
    projectChatBindings: [
      {
        projectId: 'metabot',
        chats: [
          { bot: 'admin', chatId: 'chat-primary' },
          { bot: 'pm-savio', chatId: 'chat-review' },
        ],
      },
    ],
    dispatch: {
      issuer: 'core-bridge',
      audience: 'metabot-host:imac',
      allowedIssuers: ['core-bridge', 'savio-bridge'],
    },
  },
};

describe('shared RulesPack bot configuration', () => {
  it('inherits required defaults with per-bot and per-surface databases', () => {
    const bridge = resolveRulesPackBotConfig({ botName: 'pm/a', engine: 'codex', defaults });
    const worker = resolveRulesPackBotConfig({ botName: 'pm/a', engine: 'codex', surface: 'worker', defaults });

    expect(bridge.policy).toEqual({ state: 'inherited', required: true });
    expect(bridge.rulesPack?.dbPath).toBe('/tmp/rulespack/bridge-pm%2Fa.sqlite');
    expect(worker.rulesPack?.dbPath).toBe('/tmp/rulespack/worker-pm%2Fa.sqlite');
    expect(worker.rulesPack?.metaMemory?.paths).toEqual(['/imac/rules/codex/metabot-development']);
    expect(bridge.rulesPack?.projectChatBindings?.[0]?.chats).toHaveLength(2);
    expect(bridge.rulesPack?.dispatch).toEqual({
      issuer: 'core-bridge',
      audience: 'metabot-host:imac',
      allowedIssuers: ['core-bridge', 'savio-bridge'],
    });
    expect(worker.rulesPack?.dispatch).toEqual({
      issuer: 'core-bridge',
      audience: 'metabot-host:imac',
      allowedIssuers: ['core-bridge', 'savio-bridge'],
    });
    const otherBot = resolveRulesPackBotConfig({ botName: 'secretary', engine: 'codex', defaults });
    expect(otherBot.rulesPack?.dispatch?.issuer).toBe('core-bridge');
  });

  it('allows operational overrides without replacing required sources', () => {
    const resolved = resolveRulesPackBotConfig({
      botName: 'admin',
      engine: 'codex',
      defaults,
      override: { mode: 'enforce', budget: { maxTokens: 500 } },
    });
    expect(resolved.policy.state).toBe('overridden');
    expect(resolved.rulesPack).toMatchObject({
      mode: 'enforce',
      budget: { maxTokens: 500 },
      metaMemory: { required: true },
    });
  });

  it('rejects required opt-out and required-source replacement', () => {
    expect(() => resolveRulesPackBotConfig({
      botName: 'admin',
      engine: 'codex',
      defaults,
      override: false,
      optOutReason: 'maintenance',
    })).toThrow('cannot opt out');

    expect(() => resolveRulesPackBotConfig({
      botName: 'admin',
      engine: 'codex',
      defaults,
      override: { metaMemory: { hostRoot: '/imac', paths: [], required: false } },
    })).toThrow('cannot replace required RulesPack default');
    expect(() => resolveRulesPackBotConfig({
      botName: 'admin', engine: 'codex', defaults, override: { mode: 'off' },
    })).toThrow('cannot replace required RulesPack default mode');
    expect(() => resolveRulesPackBotConfig({
      botName: 'admin',
      engine: 'codex',
      defaults: { ...defaults, config: { ...defaults.config, mode: 'enforce' } },
      override: { mode: 'shadow' },
    })).toThrow('cannot replace required RulesPack default mode');
    expect(() => resolveRulesPackBotConfig({
      botName: 'admin',
      engine: 'codex',
      defaults,
      override: { metaMemory: { ...defaults.config.metaMemory!, coreUrl: 'http://127.0.0.1:9300' } },
    })).toThrow('cannot replace required RulesPack default metaMemory');
    expect(() => resolveRulesPackBotConfig({
      botName: 'secretary',
      engine: 'codex',
      defaults,
      override: { dispatch: { issuer: 'admin', audience: 'other', allowedIssuers: [] } },
    })).toThrow('cannot replace required RulesPack default dispatch');
    expect(() => resolveRulesPackBotConfig({
      botName: 'secretary',
      engine: 'codex',
      defaults,
      override: { projectChatBindings: [] },
    })).toThrow('cannot replace required RulesPack default projectChatBindings.metabot:admin/chat-primary');
  });

  it('requires an audited reason for optional opt-out', () => {
    const optional = { ...defaults, policy: 'optional' as const };
    expect(() => resolveRulesPackBotConfig({
      botName: 'admin', engine: 'codex', defaults: optional, override: false,
    })).toThrow('requires rulesPackOptOutReason');
    expect(resolveRulesPackBotConfig({
      botName: 'admin',
      engine: 'codex',
      defaults: optional,
      override: false,
      optOutReason: 'External compliance runner owns policy delivery.',
    }).policy).toEqual({
      state: 'opted-out',
      required: false,
      optOutReason: 'External compliance runner owns policy delivery.',
    });
  });

  it('supports Claude with the same defaults while keeping Kimi unsupported', () => {
    expect(resolveRulesPackBotConfig({ botName: 'kimi', engine: 'kimi', defaults }).policy.state).toBe('unsupported');
    expect(resolveRulesPackBotConfig({ botName: 'claude', engine: 'claude', defaults })).toMatchObject({
      policy: { state: 'inherited', required: true },
      rulesPack: { mode: 'shadow' },
    });
    expect(() => resolveRulesPackBotConfig({
      botName: 'kimi', engine: 'kimi', defaults, override: { mode: 'enforce' },
    })).toThrow('supports Codex and Claude only');
  });

  it('refuses shared default databases that omit bot or surface isolation', () => {
    expect(() => resolveRulesPackBotConfig({
      botName: 'admin',
      engine: 'codex',
      defaults: { policy: 'required', config: { dbPath: '/tmp/shared.sqlite' } },
    })).toThrow('must contain both {surface} and {bot}');
  });

  it('rejects legacy bot/surface templates in authenticated dispatch identities', () => {
    expect(() => resolveRulesPackBotConfig({
      botName: 'secretary',
      engine: 'codex',
      defaults: {
        ...defaults,
        config: { ...defaults.config, dispatch: { ...defaults.config.dispatch, issuer: '{bot}' } },
      },
    })).toThrow('replace {bot}/{surface} with the botName returned by metabot agents whoami');
    expect(() => resolveRulesPackBotConfig({
      botName: 'secretary',
      engine: 'codex',
      defaults: {
        ...defaults,
        config: {
          ...defaults.config,
          dispatch: { ...defaults.config.dispatch, allowedIssuers: ['core-bridge', '{surface}'] },
        },
      },
    })).toThrow('dispatch allowedIssuers[1] must be a fixed authenticated transport identity');
  });
});
