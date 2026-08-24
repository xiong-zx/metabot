import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkerRulesPackProvider } from '../src/rulespack.js';
import { MetaBotRulesPackRuntime } from '@metabot/rulespack-adapter';
import {
  dispatchEnvelopeFingerprint,
  type RuleInputV1,
  type RulesPackChildGrantV1,
} from '@metabot/rulespack';
import type { WorkerRecord } from '../src/types.js';

const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture(config: (directory: string) => object): { directory: string; configPath: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-rulespack-defaults-'));
  temporary.push(directory);
  const configPath = path.join(directory, 'bots.json');
  fs.writeFileSync(configPath, JSON.stringify(config(directory)), { mode: 0o600 });
  return { directory, configPath };
}

function worker(directory: string, botName: string): WorkerRecord {
  return {
    id: `worker-${botName}`,
    botName,
    chatId: `chat-${botName}`,
    principalRole: 'user',
    executionKind: 'worker',
    workdir: directory,
    prompt: 'work',
    engine: 'codex',
    dedupePolicy: { completedTtlMs: 1_000, retryTerminal: false },
    timeoutMs: 60_000,
    idleTimeoutMs: 60_000,
    recoveryPolicy: { restart: 'manual', idempotent: false },
    status: 'queued',
    launchCount: 0,
    recoveryCount: 0,
    createdAt: Date.now(),
    stdoutTruncated: false,
    stderrTruncated: false,
    notificationState: 'pending',
    notificationAttempts: 0,
  };
}

describe('Worker Runner RulesPack defaults', () => {
  it('rebinds a received parent dispatch into the separate exact Worker database only', async () => {
    const { directory, configPath } = fixture((directory) => ({
      rulesPackDefaults: {
        policy: 'required',
        config: {
          mode: 'enforce',
          hostId: 'imac',
          dbPath: path.join(directory, '{surface}-{bot}.sqlite'),
          dispatch: { audience: 'metabot-host:imac', allowedIssuers: ['remote-bridge'] },
        },
      },
      webBots: [{ name: 'admin', engine: 'codex' }],
    }));
    const sentRule: RuleInputV1 = {
      schemaVersion: 1,
      id: 'received-only',
      version: '1',
      text: 'Apply the received detached policy.',
      scope: 'global',
      targets: {},
      authority: 'user-approved',
      priority: 10,
      overridable: false,
      lifecycle: { status: 'approved' },
      source: { kind: 'config', adapterId: 'sender', ref: 'sender', revision: '1' },
    };
    const sender = new MetaBotRulesPackRuntime({
      mode: 'enforce',
      hostId: 'sender',
      dbPath: path.join(directory, 'sender.sqlite'),
      dispatch: { issuer: 'remote-bridge' },
      configRules: { id: 'sender', revision: '1', rules: [sentRule] },
    }, { debug() {}, info() {}, warn() {}, error() {} });
    const parentTarget = {
      hostId: 'imac', bot: 'admin', roles: ['user'], chatId: 'chat-admin',
      tools: ['metabot-worker'], dataClasses: ['agent-bus'], outputTypes: ['text'], engine: 'codex' as const,
    };
    const parent = await sender.createDispatchEnvelope({
      targetSubject: parentTarget,
      audience: 'metabot-host:imac',
      ttlMs: 60_000,
    });
    const grant: RulesPackChildGrantV1 = {
      schemaVersion: 1,
      purpose: 'worker',
      grantId: 'grant-1',
      capabilityDigest: 'sha256:test',
      issuedAt: parent.issuedAt,
      expiresAt: parent.expiresAt,
      depth: 1,
      parentEnvelopeFingerprint: dispatchEnvelopeFingerprint(parent),
      parent,
      constraints: { hostId: 'imac', bot: 'admin', chatId: 'chat-admin' },
      signature: { scheme: 'ed25519', value: 'verified-before-provider' },
    };
    const provider = createWorkerRulesPackProvider({ BOTS_CONFIG: configPath })!;
    try {
      const firstWorker = worker(directory, 'admin');
      const prepared = await provider.prepare(firstWorker, grant);
      expect(prepared?.injectionText).toContain('received detached policy');
      prepared?.markRejected(new Error('stdin rejected'));
      const retried = await provider.prepare(firstWorker, grant);
      expect(retried?.injectionText).toContain('received detached policy');
      retried?.markInjected();
      expect(fs.existsSync(path.join(directory, 'worker-admin.sqlite'))).toBe(true);
      expect(fs.existsSync(path.join(directory, 'bridge-admin.sqlite'))).toBe(false);
      expect((await provider.prepare(firstWorker, grant))?.injectionText).toContain('received detached policy');
      expect((await provider.prepare({ ...firstWorker, id: 'worker-other' }))?.injectionText)
        .not.toContain('received detached policy');
      await expect(provider.prepare({ ...firstWorker, chatId: 'other-chat' }, grant)).rejects.toThrow(/exact Worker subject/u);
    } finally {
      provider.close?.();
      sender.close();
    }
  });

  it('inherits BOTS_CONFIG defaults and isolates every worker bot database', async () => {
    const { directory, configPath } = fixture((directory) => ({
      rulesPackDefaults: {
        policy: 'required',
        config: {
          mode: 'enforce',
          hostId: 'imac',
          dbPath: path.join(directory, '{surface}-{bot}.sqlite'),
          configRules: {
            id: 'worker-defaults',
            revision: '1',
            required: true,
            rules: [{
              schemaVersion: 1,
              id: 'worker-policy',
              version: '1',
              text: 'Apply the canonical worker policy.',
              scope: 'global',
              targets: {},
              authority: 'user-approved',
              priority: 1,
              overridable: false,
              lifecycle: { status: 'approved' },
              source: { kind: 'config', adapterId: 'ignored', ref: 'test', revision: '1' },
            }],
          },
        },
      },
      webBots: [{ name: 'admin' }, { name: 'pm' }],
    }));
    const provider = createWorkerRulesPackProvider({ BOTS_CONFIG: configPath });
    expect(provider).toBeDefined();
    try {
      expect((await provider!.prepare(worker(directory, 'admin')))?.injectionText).toContain('canonical worker policy');
      expect((await provider!.prepare(worker(directory, 'pm')))?.injectionText).toContain('canonical worker policy');
      expect(fs.existsSync(path.join(directory, 'worker-admin.sqlite'))).toBe(true);
      expect(fs.existsSync(path.join(directory, 'worker-pm.sqlite'))).toBe(true);
      expect(fs.existsSync(path.join(directory, 'bridge-admin.sqlite'))).toBe(false);
    } finally {
      provider!.close?.();
    }
  });

  it('applies and restores a durable bot-scoped override in the current daemon provider', async () => {
    const { directory, configPath } = fixture((directory) => ({
      rulesPackDefaults: {
        policy: 'required',
        config: {
          mode: 'enforce',
          hostId: 'imac',
          dbPath: path.join(directory, '{surface}-{bot}.sqlite'),
          configRules: {
            id: 'worker-defaults',
            revision: '1',
            required: true,
            rules: [{
              schemaVersion: 1,
              id: 'worker-policy',
              version: '1',
              text: 'Apply the canonical worker policy.',
              scope: 'global',
              targets: {},
              authority: 'user-approved',
              priority: 1,
              overridable: false,
              lifecycle: { status: 'approved' },
              source: { kind: 'config', adapterId: 'ignored', ref: 'test', revision: '1' },
            }],
          },
        },
      },
      webBots: [{ name: 'admin' }],
    }));
    let provider = createWorkerRulesPackProvider({ BOTS_CONFIG: configPath })!;
    try {
      expect(provider.controlStatus?.('admin')).toMatchObject({
        state: 'configured', botScoped: true, mode: 'enforce', operatorModeVersion: 0, inFlight: 'unchanged',
      });
      const off = provider.setControlMode?.('admin', 'off', 0, 'off-1');
      expect(off).toMatchObject({
        mode: 'off',
        operatorModeVersion: 1,
        operatorModeOperationId: 'off-1',
        operatorModeOverride: { mode: 'off', updatedAt: expect.any(String) },
        appliesTo: 'subsequent-codex-policy-preparations',
        inFlight: 'unchanged',
      });
      expect((await provider.prepare(worker(directory, 'admin')))?.injectionText).toBe('');
      provider.setControlMode?.('admin', 'enforce', 1, 'enforce-2');
      expect((await provider.prepare(worker(directory, 'admin')))?.injectionText).toContain('canonical worker policy');
      provider.setControlMode?.('admin', 'off', 2, 'off-3');
    } finally {
      provider.close?.();
    }

    provider = createWorkerRulesPackProvider({ BOTS_CONFIG: configPath })!;
    try {
      expect(provider.controlStatus?.('admin')).toMatchObject({
        mode: 'off', operatorModeOverride: { mode: 'off' }, operatorModeVersion: 3,
        operatorModeOperationId: 'off-3',
      });
      expect(() => provider.setControlMode?.('admin', null, 2, 'stale-clear')).toThrow('version mismatch');
      expect(provider.setControlMode?.('admin', null, 3, 'clear-4')).toMatchObject({
        mode: 'enforce', configuredMode: 'enforce', operatorModeVersion: 4,
        operatorModeOperationId: 'clear-4',
      });
      expect(provider.controlStatus?.('admin').operatorModeOverride).toBeUndefined();
      expect((await provider.prepare(worker(directory, 'admin')))?.injectionText).toContain('canonical worker policy');
    } finally {
      provider.close?.();
    }
  });

  it('honors an audited optional per-bot opt-out', async () => {
    const { directory, configPath } = fixture((directory) => ({
      rulesPackDefaults: {
        policy: 'optional',
        config: { mode: 'enforce', dbPath: path.join(directory, '{surface}-{bot}.sqlite') },
      },
      webBots: [{ name: 'admin', rulesPack: false, rulesPackOptOutReason: 'Dedicated external policy runner.' }],
    }));
    const provider = createWorkerRulesPackProvider({ BOTS_CONFIG: configPath });
    try {
      expect(await provider!.prepare(worker(directory, 'admin'))).toBeUndefined();
    } finally {
      provider!.close?.();
    }
  });

  it('keeps legacy per-bot BOTS_CONFIG RulesPack support without defaults', async () => {
    const { directory, configPath } = fixture((directory) => ({
      webBots: [{
        name: 'legacy',
        rulesPack: {
          mode: 'enforce',
          dbPath: path.join(directory, '{surface}-legacy.sqlite'),
          configRules: {
            id: 'legacy', revision: '1', rules: [{
              schemaVersion: 1,
              id: 'legacy-worker-policy',
              version: '1',
              text: 'Apply the legacy worker policy.',
              scope: 'global',
              targets: {},
              authority: 'user-approved',
              priority: 1,
              overridable: true,
              lifecycle: { status: 'approved' },
              source: { kind: 'config', adapterId: 'ignored', ref: 'test', revision: '1' },
            }],
          },
        },
      }],
    }));
    const provider = createWorkerRulesPackProvider({ BOTS_CONFIG: configPath });
    try {
      expect((await provider!.prepare(worker(directory, 'legacy')))?.injectionText).toContain('legacy worker policy');
    } finally {
      provider!.close?.();
    }
  });

  it.each(['claude', 'kimi'] as const)('keeps a %s bot unsupported even when shared defaults exist', async (engine) => {
    const { directory, configPath } = fixture((directory) => ({
      rulesPackDefaults: {
        policy: 'required',
        config: { mode: 'enforce', dbPath: path.join(directory, '{surface}-{bot}.sqlite') },
      },
      webBots: [{ name: engine, engine }],
    }));
    const provider = createWorkerRulesPackProvider({ BOTS_CONFIG: configPath })!;
    try {
      expect(provider.controlStatus?.(engine)).toMatchObject({
        state: 'unsupported', botScoped: false, mode: 'off', operatorModeVersion: 0,
      });
      expect(() => provider.setControlMode?.(engine, 'off', 0, 'must-reject')).toThrow('supports Codex only');
      expect(await provider.prepare(worker(directory, engine))).toBeUndefined();
    } finally {
      provider.close?.();
    }
  });

  it('fails startup when two bot-scoped worker configs materialize the same database', () => {
    const { configPath } = fixture((directory) => ({
      webBots: ['admin', 'pm'].map((name) => ({
        name,
        engine: 'codex',
        rulesPack: { mode: 'enforce', dbPath: path.join(directory, '{surface}-shared.sqlite') },
      })),
    }));
    expect(() => createWorkerRulesPackProvider({ BOTS_CONFIG: configPath })).toThrow(
      'worker database for bot admin aliases worker database for bot pm',
    );
  });

  it('fails startup when distinct worker paths are hard-link aliases', () => {
    const { directory, configPath } = fixture((directory) => ({
      webBots: ['admin', 'pm'].map((name) => ({
        name,
        engine: 'codex',
        rulesPack: { mode: 'enforce', dbPath: path.join(directory, `{surface}-${name}.sqlite`) },
      })),
    }));
    fs.writeFileSync(path.join(directory, 'worker-admin.sqlite'), 'alias-fixture');
    fs.linkSync(path.join(directory, 'worker-admin.sqlite'), path.join(directory, 'worker-pm.sqlite'));
    expect(() => createWorkerRulesPackProvider({ BOTS_CONFIG: configPath })).toThrow(
      'worker database for bot admin aliases worker database for bot pm',
    );
  });

  it('fails startup when Worker A exactly aliases Bridge B', () => {
    const { configPath } = fixture((directory) => ({
      webBots: [
        {
          name: 'admin', engine: 'codex',
          rulesPack: { mode: 'enforce', dbPath: path.join(directory, '{surface}-admin.sqlite') },
        },
        {
          name: 'pm', engine: 'codex',
          rulesPack: { mode: 'enforce', dbPath: path.join(directory, 'worker-admin.sqlite') },
        },
      ],
    }));
    expect(() => createWorkerRulesPackProvider({ BOTS_CONFIG: configPath })).toThrow(
      'worker database for bot admin aliases bridge database for bot pm',
    );
  });

  it('fails startup when Worker A is a hard-link alias of Bridge B', () => {
    const { directory, configPath } = fixture((directory) => ({
      webBots: ['admin', 'pm'].map((name) => ({
        name,
        engine: 'codex',
        rulesPack: { mode: 'enforce', dbPath: path.join(directory, `{surface}-${name}.sqlite`) },
      })),
    }));
    fs.writeFileSync(path.join(directory, 'worker-admin.sqlite'), 'cross-surface-alias');
    fs.linkSync(path.join(directory, 'worker-admin.sqlite'), path.join(directory, 'bridge-pm.sqlite'));
    expect(() => createWorkerRulesPackProvider({ BOTS_CONFIG: configPath })).toThrow(
      'worker database for bot admin aliases bridge database for bot pm',
    );
  });

  it('rechecks the full Bridge and Worker claim set before hot control', () => {
    const { directory, configPath } = fixture((directory) => ({
      webBots: ['admin', 'pm'].map((name) => ({
        name,
        engine: 'codex',
        rulesPack: { mode: 'enforce', dbPath: path.join(directory, `{surface}-${name}.sqlite`) },
      })),
    }));
    const provider = createWorkerRulesPackProvider({ BOTS_CONFIG: configPath })!;
    try {
      fs.writeFileSync(path.join(directory, 'worker-admin.sqlite'), 'late-cross-surface-alias');
      fs.linkSync(path.join(directory, 'worker-admin.sqlite'), path.join(directory, 'bridge-pm.sqlite'));
      expect(() => provider.controlStatus?.('admin')).toThrow(
        'worker database for bot admin aliases bridge database for bot pm',
      );
    } finally {
      provider.close?.();
    }
  });

  it.skipIf(process.platform === 'win32')('fails startup when a worker database path is a symlink', () => {
    const { directory, configPath } = fixture((directory) => ({
      webBots: ['admin', 'pm'].map((name) => ({
        name, engine: 'codex',
        rulesPack: { mode: 'enforce', dbPath: path.join(directory, `{surface}-${name}.sqlite`) },
      })),
    }));
    fs.writeFileSync(path.join(directory, 'bridge-pm.sqlite'), 'symlink-target');
    fs.symlinkSync(path.join(directory, 'bridge-pm.sqlite'), path.join(directory, 'worker-admin.sqlite'));
    expect(() => createWorkerRulesPackProvider({ BOTS_CONFIG: configPath })).toThrow(
      'database must not be a symlink',
    );
  });

  it('rejects ambiguous standalone and shared bot configuration', () => {
    const { configPath } = fixture(() => ({ rulesPackDefaults: {
      policy: 'required', config: { dbPath: '/tmp/{surface}-{bot}.sqlite' },
    } }));
    expect(() => createWorkerRulesPackProvider({
      BOTS_CONFIG: configPath,
      METABOT_RULESPACK_CONFIG: configPath,
    })).toThrow('mutually exclusive');
  });

  it('refuses to pretend a standalone shared runtime supports bot-scoped control', () => {
    const { configPath } = fixture((directory) => ({
      mode: 'enforce',
      dbPath: path.join(directory, 'standalone.sqlite'),
    }));
    const provider = createWorkerRulesPackProvider({ METABOT_RULESPACK_CONFIG: configPath })!;
    try {
      expect(provider.controlStatus?.('admin')).toMatchObject({ state: 'standalone-shared', botScoped: false });
      expect(() => provider.setControlMode?.('admin', 'off', 0, 'standalone')).toThrow('Bot-scoped');
    } finally {
      provider.close?.();
    }
  });
});
