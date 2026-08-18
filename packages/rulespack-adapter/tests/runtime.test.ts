import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RulesPackError, type RuleInputV1 } from '@metabot/rulespack';
import { MetaBotRulesPackRuntime, resolveRulesPackDbPath } from '../src/runtime.js';

const temporary: string[] = [];
const logger = { debug() {}, info() {}, warn() {}, error() {} };

afterEach(() => {
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function temp(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rulespack-adapter-'));
  temporary.push(directory);
  return directory;
}

function rule(id: string, text: string, extras: Partial<RuleInputV1> = {}): RuleInputV1 {
  return {
    schemaVersion: 1,
    id,
    version: '1',
    text,
    scope: 'global',
    targets: {},
    authority: 'user-approved',
    priority: 0,
    overridable: true,
    lifecycle: { status: 'approved' },
    source: { kind: 'config', adapterId: 'ignored', ref: 'test', revision: '1' },
    ...extras,
  };
}

function facts(root: string, overrides: Record<string, unknown> = {}) {
  return {
    botName: 'admin',
    chatId: 'chat-a',
    roles: ['user'],
    cwd: root,
    userId: 'user-a',
    tools: ['shell'],
    dataClasses: ['chat'],
    outputTypes: ['text'],
    ...overrides,
  } as any;
}

describe('MetaBot RulesPack runtime', () => {
  it('defaults off and keeps off/shadow/enforce injection semantics truthful', async () => {
    const root = temp();
    const dbPath = path.join(root, 'rules-state.sqlite');
    const runtime = new MetaBotRulesPackRuntime(
      {
        hostId: 'imac',
        dbPath,
        configRules: { id: 'config', revision: '1', rules: [rule('concise', 'Answer concisely.')] },
      },
      logger,
    );
    const off = await runtime.prepareTurn(facts(root));
    expect(off.mode).toBe('off');
    expect(off.injectionText).toBe('');
    expect(off.telemetry.cache).toBe('bypass-off');

    runtime.setMode('shadow');
    const shadow = await runtime.prepareTurn(facts(root));
    expect(shadow.injectionText).toBe('');
    expect(shadow.telemetry.selectedRuleCount).toBe(1);

    runtime.setMode('enforce');
    const enforce = await runtime.prepareTurn(facts(root));
    expect(enforce.injectionText).toContain('Answer concisely.');
    expect(runtime.receipts().some((item) => item.status === 'injected')).toBe(false);
    enforce.markInjected();
    enforce.markInjected();
    expect(runtime.receipts().filter((item) => item.status === 'injected')).toHaveLength(1);
    runtime.close();
  });

  it('binds project-native rules to configured roots with no cross-project leakage', async () => {
    const root = temp();
    const projectA = path.join(root, 'a');
    const projectB = path.join(root, 'b');
    fs.mkdirSync(projectA);
    fs.mkdirSync(projectB);
    fs.writeFileSync(
      path.join(projectA, 'rules.json'),
      JSON.stringify({
        schemaVersion: 1,
        revision: '1',
        rules: [rule('project-a', 'Use project A conventions.', { scope: 'project' })],
      }),
    );
    const runtime = new MetaBotRulesPackRuntime(
      {
        mode: 'enforce',
        hostId: 'imac',
        dbPath: path.join(root, 'rules-state.sqlite'),
        projectBindings: [
          {
            projectId: 'project-a',
            root: projectA,
            nativeFiles: [{ id: 'project-a-file', path: 'rules.json' }],
          },
        ],
      },
      logger,
    );
    expect((await runtime.prepareTurn(facts(projectA))).injectionText).toContain('project A');
    expect((await runtime.prepareTurn(facts(projectB))).injectionText).not.toContain('project A');
    runtime.close();
  });

  it('reuses unchanged digest, invalidates changed generations, and rejects unsafe path escape', async () => {
    const root = temp();
    const project = path.join(root, 'project');
    fs.mkdirSync(project);
    const rulesFile = path.join(project, 'rules.json');
    const write = (revision: string, text: string) =>
      fs.writeFileSync(
        rulesFile,
        JSON.stringify({
          schemaVersion: 1,
          revision,
          rules: [rule('project-rule', text, { scope: 'project' })],
        }),
      );
    write('1', 'First generation.');
    const runtime = new MetaBotRulesPackRuntime(
      {
        mode: 'enforce',
        hostId: 'imac',
        dbPath: path.join(root, 'rules-state.sqlite'),
        projectBindings: [{ projectId: 'project', root: project, nativeFiles: [{ id: 'file', path: 'rules.json' }] }],
      },
      logger,
    );
    const first = await runtime.prepareTurn(facts(project));
    const second = await runtime.prepareTurn(facts(project));
    expect(second.packDigest).toBe(first.packDigest);
    expect(second.telemetry.cache).toBe('hit-memory');
    write('2', 'Second generation.');
    await runtime.refresh();
    const changed = await runtime.prepareTurn(facts(project));
    expect(changed.packDigest).not.toBe(first.packDigest);
    expect(changed.injectionText).toContain('Second generation.');
    runtime.close();

    const outside = path.join(root, 'outside.json');
    fs.writeFileSync(outside, '{}');
    fs.symlinkSync(outside, path.join(project, 'escape.json'));
    const escaped = new MetaBotRulesPackRuntime(
      {
        mode: 'enforce',
        hostId: 'imac',
        dbPath: path.join(root, 'escape.sqlite'),
        projectBindings: [
          { projectId: 'project', root: project, nativeFiles: [{ id: 'escape', path: 'escape.json', required: true }] },
        ],
      },
      logger,
    );
    await expect(escaped.prepareTurn(facts(project))).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
    escaped.close();
  });

  it('authenticates target-bound envelopes and rejects audience mismatch and replay', async () => {
    const root = temp();
    const sender = new MetaBotRulesPackRuntime(
      {
        mode: 'enforce',
        hostId: 'imac',
        dbPath: path.join(root, 'sender.sqlite'),
        dispatch: { issuer: 'admin@imac' },
        configRules: { id: 'sender', revision: '1', rules: [rule('sent', 'Delivered policy.')] },
      },
      logger,
    );
    const receiver = new MetaBotRulesPackRuntime(
      {
        mode: 'enforce',
        hostId: 'savio',
        dbPath: path.join(root, 'receiver.sqlite'),
        dispatch: { audience: 'metabot-host:savio', allowedIssuers: ['admin@imac'] },
      },
      logger,
    );
    const childFacts = facts(root, { botName: 'pm-savio' });
    const envelope = await sender.createDispatchEnvelope({
      facts: { ...childFacts, botName: 'pm-savio' },
      audience: 'metabot-host:savio',
      targetHostId: 'savio',
    });
    const accepted = await receiver.prepareTurn(childFacts, {
      envelope,
      transport: { authenticated: true, authenticatedIssuer: 'admin@imac' },
    });
    expect(accepted.injectionText).toContain('Delivered policy.');
    const continued = await receiver.prepareTurn(childFacts);
    expect(continued.packDigest).toBe(accepted.packDigest);
    expect(continued.injectionText).toContain('Delivered policy.');

    const childRuntime = new MetaBotRulesPackRuntime(
      { mode: 'enforce', hostId: 'savio', dbPath: path.join(root, 'receiver.sqlite') },
      logger,
    );
    const worker = await childRuntime.prepareTurn(facts(root, {
      botName: 'pm-savio', workerId: 'worker-1', taskId: 'worker-1',
      roles: ['worker'], dataClasses: ['worker'],
    }));
    expect(worker.injectionText).toContain('Delivered policy.');
    await expect(
      receiver.prepareTurn(childFacts, {
        envelope,
        transport: { authenticated: true, authenticatedIssuer: 'admin@imac' },
      }),
    ).rejects.toThrow(/replay/u);
    await expect(
      receiver.prepareTurn(childFacts, {
        envelope: { ...envelope, replayId: 'new-replay', audience: 'wrong-host' },
        transport: { authenticated: true, authenticatedIssuer: 'admin@imac' },
      }),
    ).rejects.toThrow(/audience/u);
    childRuntime.close();
    sender.close();
    receiver.close();
  });

  it('rejects reserved databases and cross-host MetaMemory namespaces', () => {
    const root = temp();
    expect(() => resolveRulesPackDbPath(path.join(root, 'sessions.db'))).toThrow(/own SQLite/u);
    expect(
      () =>
        new MetaBotRulesPackRuntime(
          {
            hostId: 'savio',
            dbPath: path.join(root, 'rules.sqlite'),
            metaMemory: { paths: ['/imac/rules/x'], hostRoot: '/imac' },
          },
          logger,
        ),
    ).toThrowError(RulesPackError);
  });
});
