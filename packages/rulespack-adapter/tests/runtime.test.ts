import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('rebinds received Rules to the exact envelope subject with no chat/project/agent/worker/task leakage', async () => {
    const root = temp();
    const projectA = path.join(root, 'project-a');
    const projectB = path.join(root, 'project-b');
    fs.mkdirSync(projectA);
    fs.mkdirSync(projectB);
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
        projectBindings: [
          { projectId: 'project-a', root: projectA },
          { projectId: 'project-b', root: projectB },
        ],
      },
      logger,
    );
    const childFacts = facts(projectA, {
      botName: 'pm-savio',
      agentName: 'agent-a',
      workerId: 'worker-a',
      taskId: 'task-a',
      roles: ['worker'],
      dataClasses: ['worker'],
    });
    const envelope = await sender.createDispatchEnvelope({
      targetSubject: receiver.buildSubject(childFacts),
      audience: 'metabot-host:savio',
    });
    for (const mismatch of [
      { chatId: 'chat-b' },
      { cwd: projectB },
      { agentName: 'agent-b' },
      { workerId: 'worker-b' },
      { taskId: 'task-b' },
    ]) {
      const mismatchedEnvelope = await sender.createDispatchEnvelope({
        targetSubject: receiver.buildSubject(childFacts),
        audience: 'metabot-host:savio',
      });
      await expect(receiver.prepareTurn({ ...childFacts, ...mismatch }, {
        envelope: mismatchedEnvelope,
        transport: { authenticated: true, authenticatedIssuer: 'admin@imac' },
      })).rejects.toThrow(/target fingerprint/u);
    }
    const accepted = await receiver.prepareTurn(childFacts, {
      envelope,
      transport: { authenticated: true, authenticatedIssuer: 'admin@imac' },
    });
    expect(accepted.injectionText).toContain('Delivered policy.');
    expect(receiver.receipts().some((item) => item.status === 'consumed')).toBe(false);
    accepted.markInjected();
    expect(receiver.receipts().some((item) => item.status === 'consumed')).toBe(true);
    const continued = await receiver.prepareTurn(childFacts);
    expect(continued.packDigest).toBe(accepted.packDigest);
    expect(continued.injectionText).toContain('Delivered policy.');
    for (const different of [
      { chatId: 'chat-b' },
      { cwd: projectB },
      { agentName: 'agent-b' },
      { workerId: 'worker-b' },
      { taskId: 'task-b' },
    ]) {
      const isolated = await receiver.prepareTurn({ ...childFacts, ...different });
      expect(isolated.injectionText).not.toContain('Delivered policy.');
    }
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
    sender.close();
    receiver.close();
  });

  it('captures prepared mode and records acceptance only after successful target input', async () => {
    const root = temp();
    const runtime = new MetaBotRulesPackRuntime({
      mode: 'enforce',
      hostId: 'imac',
      dbPath: path.join(root, 'receipts.sqlite'),
      configRules: { id: 'config', revision: '1', rules: [rule('receipt', 'Receipt rule.')] },
    }, logger);
    const failed = await runtime.prepareTurn(facts(root));
    failed.markRejected(new Error('spawn rejected'));
    expect(runtime.receipts().some((item) => item.status === 'injected')).toBe(false);
    expect(runtime.receipts().some((item) => item.status === 'rejected')).toBe(true);

    const prepared = await runtime.prepareTurn(facts(root));
    runtime.setMode('off');
    prepared.markInjected();
    expect(prepared.mode).toBe('enforce');
    expect(runtime.receipts().filter((item) => item.status === 'injected')).toHaveLength(1);

    runtime.setMode('shadow');
    const shadow = await runtime.prepareTurn(facts(root));
    shadow.markInjected();
    expect(runtime.receipts().filter((item) => item.status === 'injected')).toHaveLength(1);
    runtime.setMode('off');
    const off = await runtime.prepareTurn(facts(root));
    off.markInjected();
    expect(runtime.receipts().filter((item) => item.status === 'injected')).toHaveLength(1);
    runtime.close();
  });

  it('restores a validated durable operator mode override across restart until cleared', async () => {
    const root = temp();
    const dbPath = path.join(root, 'mode.sqlite');
    let runtime = new MetaBotRulesPackRuntime({ mode: 'enforce', hostId: 'imac', dbPath }, logger);
    runtime.setMode('off');
    runtime.close();
    runtime = new MetaBotRulesPackRuntime({ mode: 'enforce', hostId: 'imac', dbPath }, logger);
    expect(runtime.status().mode).toBe('off');
    expect((await runtime.prepareTurn(facts(root))).injectionText).toBe('');
    expect(runtime.clearModeOverride().mode).toBe('enforce');
    runtime.close();
  });

  it('changes digest and misses cache when native-loaded instruction content changes without duplicate injection', async () => {
    const root = temp();
    const project = path.join(root, 'project');
    fs.mkdirSync(project);
    const agents = path.join(project, 'AGENTS.md');
    fs.writeFileSync(agents, '# Native instruction one\n');
    const runtime = new MetaBotRulesPackRuntime({
      mode: 'enforce',
      hostId: 'imac',
      dbPath: path.join(root, 'native.sqlite'),
      configRules: { id: 'config', revision: '1', rules: [rule('rendered', 'Rendered exactly once.')] },
      projectBindings: [{
        projectId: 'project',
        root: project,
        nativeFiles: [{ id: 'agents', path: 'AGENTS.md', format: 'agents-json-block', nativeLoaded: true }],
      }],
    }, logger);
    const first = await runtime.prepareTurn(facts(project));
    expect(first.injectionText).toContain('Rendered exactly once.');
    expect(first.injectionText).not.toContain('Native instruction one');
    fs.writeFileSync(agents, '# Native instruction two\n');
    await runtime.refresh();
    const changed = await runtime.prepareTurn(facts(project));
    expect(changed.packDigest).not.toBe(first.packDigest);
    expect(changed.telemetry.cache).toBe('miss');
    expect(changed.injectionText).not.toContain('Native instruction two');
    expect(changed.injectionText.match(/Rendered exactly once\./gu)).toHaveLength(1);
    runtime.close();
  });

  it('schedules configured source refresh before its freshness deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T06:00:00.000Z'));
    const root = temp();
    const runtime = new MetaBotRulesPackRuntime({
      mode: 'shadow',
      hostId: 'imac',
      dbPath: path.join(root, 'freshness.sqlite'),
      configRules: { id: 'fresh', revision: '1', freshForMs: 10_000, rules: [] },
    }, logger);
    await runtime.initialize();
    const firstObservedAt = runtime.status().sources[0]?.observedAt;
    await vi.advanceTimersByTimeAsync(9_000);
    expect(runtime.status().sources[0]?.observedAt).not.toBe(firstObservedAt);
    expect(runtime.status().sources[0]?.health).toBe('fresh');
    runtime.close();
    vi.useRealTimers();
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
    expect(
      () => new MetaBotRulesPackRuntime({
        hostId: 'imac',
        dbPath: path.join(root, 'remote-memory.sqlite'),
        metaMemory: { paths: ['/imac/rules/x'], hostRoot: '/imac', coreUrl: 'http://imac.example:9200' },
      }, logger),
    ).toThrow(/host-local\/loopback/u);
  });

  it('rejects canonical/symlink aliases and existing foreign SQLite schemas', () => {
    const root = temp();
    const live = path.join(root, 'live.sqlite');
    const foreign = new DatabaseSync(live);
    foreign.exec('CREATE TABLE worker_jobs(id TEXT PRIMARY KEY)');
    foreign.close();
    expect(() => new MetaBotRulesPackRuntime({ hostId: 'imac', dbPath: live }, logger)).toThrow(/foreign application schema/u);

    const alias = path.join(root, 'rules-alias.sqlite');
    fs.symlinkSync(live, alias);
    expect(() => new MetaBotRulesPackRuntime({
      hostId: 'imac',
      dbPath: alias,
      protectedDbPaths: [path.join(root, '.', 'live.sqlite')],
    }, logger)).toThrow(/aliases a configured live/u);
  });
});
