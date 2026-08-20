import type * as http from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { handleBotRoutes } from '../src/api/routes/bot-routes.js';
import { handleTaskRoutes } from '../src/api/routes/task-routes.js';
import type { RouteContext } from '../src/api/routes/types.js';
import { resolveRulesPackApiPrincipal } from '../src/extensions/rulespack-api-principal.js';
import { forwardAuthenticatedPeerTask as forwardAuthenticatedPeerTaskImpl } from '../src/extensions/rulespack-peer-dispatch.js';
import { rulesPackProjectChatSubjectKey } from '../src/extensions/rulespack-peer-project.js';
import { BotRegistry } from '../src/api/bot-registry.js';
import { MetaBotRulesPackRuntime } from '../packages/rulespack-adapter/src/runtime.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} } as any;

function request(body: Record<string, unknown> = {}, headers: Record<string, string> = {}): http.IncomingMessage {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as http.IncomingMessage;
  req.headers = headers;
  return req;
}

function response() {
  const output: { status: number; body?: any } = { status: 0 };
  const res = {
    writeHead: vi.fn((status: number) => {
      output.status = status;
      return res;
    }),
    end: vi.fn((body?: string) => {
      if (body) output.body = JSON.parse(body);
      return res;
    }),
  } as unknown as http.ServerResponse;
  return { res, output };
}

function registryForIssuer(identity: string, operator: object): any {
  const bot = {
    name: identity,
    config: { rulesPack: { dispatch: { issuer: identity } } },
    bridge: { getRulesPackOperator: () => operator },
  };
  return {
    get: (name: string) => name === identity ? bot : undefined,
    listRegistered: () => [bot],
  };
}

function forwardAuthenticatedPeerTask(input: any): Promise<object> {
  const peerBot = input.peerBot?.engine === 'codex' && input.peerBot?.rulesPackStatus
    ? {
        ...input.peerBot,
        rulesPackIdentity: input.peerBot.rulesPackIdentity ?? {
          hostId: input.peer.name,
          audience: `metabot-host:${input.peer.name}`,
        },
      }
    : input.peerBot;
  return forwardAuthenticatedPeerTaskImpl({ ...input, peerBot });
}

describe('RulesPack operator and transport routes', () => {
  it('advertises the live operator mode instead of stale config mode', () => {
    const registry = new BotRegistry();
    registry.register({
      name: 'admin',
      platform: 'web',
      config: {
        name: 'admin', engine: 'codex', rulesPack: {
          mode: 'enforce',
          projectChatBindings: [{
            projectId: 'project-chat',
            chats: [
              { bot: 'admin', chatId: 'oc_project_chat' },
              { bot: 'other', chatId: 'oc_other_chat' },
            ],
          }],
        },
        rulesPackPolicy: { state: 'inherited', required: true },
        claude: { defaultWorkingDirectory: '/tmp' },
      } as any,
      bridge: { getRulesPackOperator: () => ({
        status: () => ({ mode: 'off', hostId: 'imac', audience: 'metabot-host:imac' }),
        projectIdForCwd: () => 'project-a',
      }) } as any,
      sender: {} as any,
    });
    expect(registry.list()[0].rulesPackStatus).toMatchObject({
      state: 'inherited', required: true, mode: 'off', defaultProjectId: 'project-a',
      projectChatAttestations: [{
        subjectKey: rulesPackProjectChatSubjectKey('admin', 'oc_project_chat'),
        projectId: 'project-chat',
      }],
    });
    expect(JSON.stringify(registry.list()[0].rulesPackStatus)).not.toContain('oc_project_chat');
    expect(registry.list()[0].rulesPackIdentity).toEqual({ hostId: 'imac', audience: 'metabot-host:imac' });
  });

  it('derives scoped local principals, rejects envelope mismatch, and keeps bearer-only calls generic', () => {
    expect(
      resolveRulesPackApiPrincipal({ localAdministrator: true }, { botName: 'admin', chatId: 'chat-a' }),
    ).toMatchObject({ kind: 'scoped', botName: 'admin', chatId: 'chat-a', roles: ['api-admin'] });
    expect(
      resolveRulesPackApiPrincipal(
        { localAdministrator: true },
        {
          botName: 'pm',
          chatId: 'team:research:worker-a',
          declarations: {
            projectId: 'project-a',
            agentName: 'worker-a',
            workerId: 'worker-a',
            taskId: 'task-a',
            roles: ['worker'],
            tools: ['metabot-worker'],
            dataClasses: ['worker'],
            outputTypes: ['json'],
          },
        },
      ),
    ).toMatchObject({
      kind: 'scoped',
      source: 'local-admin',
      projectId: 'project-a',
      agentName: 'worker-a',
      workerId: 'worker-a',
      taskId: 'task-a',
      roles: ['api-admin', 'worker'],
      tools: ['metabot-worker'],
      dataClasses: ['api', 'worker'],
      outputTypes: ['json'],
    });
    expect(
      resolveRulesPackApiPrincipal(
        { localAdministrator: false, coreBearerBotName: 'caller-bot' },
        { botName: 'admin', chatId: 'caller-selected-chat' },
      ),
    ).toEqual({ kind: 'generic', source: 'core-bearer', botName: 'caller-bot' });

    const dispatch = {
      target: {
        hostId: 'savio',
        bot: 'pm',
        roles: ['worker'],
        worker: 'worker-a',
        projectId: 'project-a',
        chatId: 'chat-a',
        taskId: 'task-a',
        tools: [],
        dataClasses: ['worker'],
        outputTypes: ['text'],
        engine: 'codex',
      },
    } as any;
    expect(
      resolveRulesPackApiPrincipal(
        { localAdministrator: false, coreBearerBotName: 'issuer' },
        {
          botName: 'pm',
          chatId: 'chat-a',
          dispatch,
          declarations: {
            projectId: 'project-a',
            workerId: 'worker-a',
            taskId: 'task-a',
            roles: ['worker'],
          },
        },
      ),
    ).toMatchObject({
      kind: 'scoped',
      projectId: 'project-a',
      workerId: 'worker-a',
      taskId: 'task-a',
      tools: [],
    });
    expect(() =>
      resolveRulesPackApiPrincipal(
        { localAdministrator: false, coreBearerBotName: 'issuer' },
        { botName: 'pm', chatId: 'chat-b', dispatch },
      ),
    ).toThrow(/does not match/u);
    for (const declarations of [{ projectId: 'project-b' }, { workerId: 'worker-b' }, { taskId: 'task-b' }]) {
      expect(() =>
        resolveRulesPackApiPrincipal(
          { localAdministrator: false, coreBearerBotName: 'issuer' },
          { botName: 'pm', chatId: 'chat-a', dispatch, declarations },
        ),
      ).toThrow(/identity declaration/u);
    }
    expect(() =>
      resolveRulesPackApiPrincipal(
        { localAdministrator: false, coreBearerBotName: 'caller-bot' },
        { botName: 'admin', chatId: 'chat-a', declarations: { workerId: 'caller-worker' } },
      ),
    ).toThrow(/require an authenticated exact dispatch/u);
  });

  it('automatically attaches an exact authenticated envelope for normal peer/relay forwarding', async () => {
    const envelope = {
      envelopeId: 'envelope-a', replayId: 'replay-a', packDigest: 'digest-a', issuer: 'caller-bot',
      target: { hostId: 'savio', bot: 'pm', chatId: 'chat-a' },
    } as any;
    const operator = {
      createDispatchEnvelope: vi.fn(async () => envelope),
      recordDispatchRejected: vi.fn(),
    };
    const forwardTask = vi.fn(async (_peer, body) => ({
      accepted: true,
      body,
      rulesPackDelivery: {
        status: 'consumed', envelopeId: 'envelope-a', replayId: 'replay-a', packDigest: 'digest-a',
      },
    }));
    const result = await forwardAuthenticatedPeerTask({
      registry: registryForIssuer('caller-bot', operator),
      peerManager: { forwardTask } as any,
      peer: { name: 'registry-pm', url: 'inbox:' },
      peerBot: {
        name: 'pm', engine: 'codex', rulesPackTools: ['metabot-worker'],
        rulesPackStatus: { state: 'inherited', required: true, mode: 'enforce', defaultProjectId: null },
        rulesPackIdentity: { hostId: 'savio', audience: 'rulespack-target:savio' },
      } as any,
      principal: { kind: 'generic', source: 'core-bearer', botName: 'caller-bot' },
      body: { botName: 'pm', chatId: 'chat-a', prompt: 'work' },
    });
    expect(operator.createDispatchEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        audience: 'rulespack-target:savio',
        targetSubject: expect.objectContaining({
          hostId: 'savio',
          bot: 'pm',
          chatId: 'chat-a',
          roles: ['peer', 'pm'],
          tools: ['metabot-worker'],
        }),
      }),
    );
    expect(forwardTask).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ rulesPackDispatch: envelope }),
    );
    expect(result).toMatchObject({ accepted: true });
  });

  it('fails closed without an attested peer identity and rejects an envelope for another host', async () => {
    const base = {
      registry: registryForIssuer('caller-bot', { createDispatchEnvelope: vi.fn() }),
      peerManager: { forwardTask: vi.fn() } as any,
      peer: { name: 'registry-pm', url: 'inbox:' },
      principal: { kind: 'generic', source: 'core-bearer', botName: 'caller-bot' } as const,
      body: { botName: 'pm', chatId: 'chat-a', prompt: 'work' },
    };
    await expect(forwardAuthenticatedPeerTaskImpl({
      ...base,
      peerBot: {
        name: 'pm', engine: 'codex',
        rulesPackStatus: { state: 'inherited', required: true, mode: 'enforce', defaultProjectId: null },
      } as any,
    })).rejects.toThrow('does not advertise an authenticated host identity');

    await expect(forwardAuthenticatedPeerTaskImpl({
      ...base,
      peerBot: {
        name: 'pm', engine: 'codex',
        rulesPackStatus: { state: 'inherited', required: true, mode: 'enforce', defaultProjectId: null },
        rulesPackIdentity: { hostId: 'savio', audience: 'metabot-host:savio' },
      } as any,
      body: {
        ...base.body,
        rulesPackDispatch: {
          target: { hostId: 'imac' }, audience: 'metabot-host:imac',
        } as any,
      },
    })).rejects.toThrow('does not match the authenticated peer host identity');
    expect(base.peerManager.forwardTask).not.toHaveBeenCalled();
  });

  it('preserves the complete authenticated Agent Bus identity in an automatic remote subject', async () => {
    const createDispatchEnvelope = vi.fn(async ({ targetSubject }) => ({
      envelopeId: 'identity-envelope',
      replayId: 'identity-replay',
      packDigest: 'identity-digest',
      issuer: 'caller-bot',
      target: targetSubject,
    }));
    const forwardTask = vi.fn(async () => ({
      accepted: true,
      rulesPackDelivery: {
        status: 'consumed',
        envelopeId: 'identity-envelope',
        replayId: 'identity-replay',
        packDigest: 'identity-digest',
      },
    }));
    await forwardAuthenticatedPeerTask({
      registry: registryForIssuer('pm', { createDispatchEnvelope }),
      peerManager: { forwardTask } as any,
      peer: { name: 'savio', url: 'http://savio' },
      peerBot: {
        name: 'pm', engine: 'codex', rulesPackTools: ['metabot-worker'],
        rulesPackStatus: { state: 'inherited', required: true, mode: 'enforce', defaultProjectId: 'project-a' },
      } as any,
      principal: {
        kind: 'scoped',
        source: 'agent-bus',
        botName: 'pm',
        chatId: 'team:research:worker-a',
        roles: ['worker'],
        userId: 'agent-bus-user',
        agentName: 'worker-a',
        workerId: 'worker-a',
        projectId: 'project-a',
        taskId: 'task-a',
        tools: ['metabot-worker'],
        dataClasses: ['worker'],
        outputTypes: ['json'],
      },
      body: { botName: 'pm', chatId: 'team:research:worker-a', prompt: 'work' },
    });
    expect(createDispatchEnvelope).toHaveBeenCalledWith(expect.objectContaining({
      targetSubject: {
        hostId: 'savio',
        bot: 'pm',
        roles: ['agent', 'peer', 'worker'],
        agent: 'worker-a',
        worker: 'worker-a',
        userId: 'agent-bus-user',
        projectId: 'project-a',
        chatId: 'team:research:worker-a',
        taskId: 'task-a',
        tools: ['metabot-worker'],
        dataClasses: ['agent-bus', 'worker'],
        outputTypes: ['json'],
        engine: 'codex',
      },
    }));
  });

  it('uses trusted peer project metadata for an exact sender-to-receiver project-bound envelope', async () => {
    const root = mkdtempSync(join(tmpdir(), 'metabot-peer-project-'));
    const remoteProject = join(root, 'remote-project');
    const remoteDefault = join(root, 'remote-default');
    mkdirSync(remoteProject);
    mkdirSync(remoteDefault);
    const sender = new MetaBotRulesPackRuntime({
      mode: 'enforce',
      hostId: 'imac',
      dbPath: join(root, 'sender.sqlite'),
      dispatch: { issuer: 'caller-bot' },
      configRules: {
        id: 'sender',
        revision: '1',
        rules: [{
          schemaVersion: 1,
          id: 'project-rule',
          version: '1',
          text: 'Apply the remote project policy.',
          scope: 'project',
          binding: { projectId: 'project-a' },
          targets: {},
          authority: 'user-approved',
          priority: 0,
          overridable: true,
          lifecycle: { status: 'approved' },
          source: { kind: 'config', adapterId: 'sender', ref: 'test', revision: '1' },
        }],
      },
    }, logger);
    const receiver = new MetaBotRulesPackRuntime({
      mode: 'enforce',
      hostId: 'savio',
      dbPath: join(root, 'receiver.sqlite'),
      dispatch: { audience: 'metabot-host:savio', allowedIssuers: ['caller-bot'] },
      projectBindings: [{ projectId: 'project-a', root: remoteProject }],
      projectChatBindings: [{
        projectId: 'project-a',
        chats: [{ bot: 'pm', chatId: 'chat-a' }],
      }],
    }, logger);
    try {
      const forwardTask = vi.fn(async (_peer, body) => {
        const envelope = body.rulesPackDispatch!;
        expect(envelope.target.projectId).toBe('project-a');
        expect(envelope.pack.rules.map((rule: { id: string }) => rule.id)).toContain('project-rule');
        const prepared = await receiver.prepareTurn({
          botName: 'pm',
          chatId: 'chat-a',
          roles: ['peer', 'pm'],
          cwd: remoteDefault,
          tools: [],
          dataClasses: ['agent-bus'],
          outputTypes: ['text'],
        }, {
          envelope,
          transport: { authenticated: true, authenticatedIssuer: 'caller-bot' },
        });
        expect(prepared.subject.projectId).toBe('project-a');
        expect(prepared.injectionText).toContain('Apply the remote project policy.');
        prepared.markInjected();
        return {
          success: true,
          rulesPackDelivery: {
            status: 'consumed',
            envelopeId: envelope.envelopeId,
            replayId: envelope.replayId,
            packDigest: envelope.packDigest,
          },
        };
      });
      await expect(forwardAuthenticatedPeerTask({
        registry: registryForIssuer('caller-bot', sender),
        peerManager: { forwardTask } as any,
        peer: { name: 'savio', url: 'http://savio' },
        peerBot: {
          name: 'pm', engine: 'codex', rulesPackTools: [],
          rulesPackStatus: {
            state: 'inherited', required: true, mode: 'enforce', defaultProjectId: null,
            projectChatAttestations: [{
              subjectKey: rulesPackProjectChatSubjectKey('pm', 'chat-a'),
              projectId: 'project-a',
            }],
          },
        } as any,
        principal: { kind: 'generic', source: 'core-bearer', botName: 'caller-bot' },
        body: { botName: 'pm', chatId: 'chat-a', prompt: 'work' },
      })).resolves.toMatchObject({ success: true, rulesPackDelivery: { status: 'consumed' } });
    } finally {
      sender.close();
      receiver.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects malformed or internally conflicting target project attestations before compile', async () => {
    const base = {
      registry: registryForIssuer('caller-bot', { createDispatchEnvelope: vi.fn() }),
      peerManager: { forwardTask: vi.fn() } as any,
      peer: { name: 'savio', url: 'http://savio' },
      peerBot: {
        name: 'pm', engine: 'codex',
        rulesPackIdentity: { hostId: 'savio', audience: 'metabot-host:savio' },
      },
      principal: { kind: 'generic', source: 'core-bearer', botName: 'caller-bot' } as const,
      body: { botName: 'pm', chatId: 'chat-a', prompt: 'work' },
    };
    await expect(forwardAuthenticatedPeerTaskImpl({
      ...base,
      peerBot: {
        ...base.peerBot,
        rulesPackStatus: {
          state: 'inherited', required: true, mode: 'enforce', defaultProjectId: null,
          projectChatAttestations: [{ subjectKey: 'not-a-digest', projectId: 'project-a' }],
        },
      } as any,
    })).rejects.toThrow('invalid project chat attestations');

    await expect(forwardAuthenticatedPeerTaskImpl({
      ...base,
      peerBot: {
        ...base.peerBot,
        rulesPackStatus: {
          state: 'inherited', required: true, mode: 'enforce', defaultProjectId: 'project-a',
          projectChatAttestations: [{
            subjectKey: rulesPackProjectChatSubjectKey('pm', 'chat-a'),
            projectId: 'project-b',
          }],
        },
      } as any,
    })).rejects.toThrow('conflicting default and chat projects');
    expect(base.peerManager.forwardTask).not.toHaveBeenCalled();
  });

  it('resolves local-admin forwarding through the local admin operator', async () => {
    const envelope = {
      envelopeId: 'admin-envelope', replayId: 'admin-replay', packDigest: 'admin-digest', issuer: 'admin',
    } as any;
    const createDispatchEnvelope = vi.fn(async () => envelope);
    const wrongTargetDispatcher = vi.fn(async () => envelope);
    const admin = {
      name: 'admin',
      config: { rulesPack: { dispatch: { issuer: 'bridge-credential' } } },
      bridge: { getRulesPackOperator: () => ({ createDispatchEnvelope }) },
    };
    const sameNamedTarget = {
      name: 'pm',
      config: { rulesPack: { dispatch: { issuer: 'different-credential' } } },
      bridge: { getRulesPackOperator: () => ({ createDispatchEnvelope: wrongTargetDispatcher }) },
    };
    const forwardTask = vi.fn(async () => ({
      success: true,
      rulesPackDelivery: {
        status: 'consumed', envelopeId: 'admin-envelope', replayId: 'admin-replay', packDigest: 'admin-digest',
      },
    }));
    await forwardAuthenticatedPeerTask({
      registry: {
        get: (name: string) => name === 'admin' ? admin : name === 'pm' ? sameNamedTarget : undefined,
        listRegistered: () => [admin, sameNamedTarget],
      } as any,
      peerManager: { forwardTask } as any,
      peer: { name: 'savio', url: 'http://savio' },
      peerBot: {
        name: 'pm', engine: 'codex',
        rulesPackStatus: { state: 'inherited', required: true, mode: 'enforce', defaultProjectId: null },
      } as any,
      principal: {
        kind: 'scoped', source: 'local-admin', botName: 'pm', chatId: 'chat-a', roles: ['api-admin'],
      },
      body: { botName: 'pm', chatId: 'chat-a', prompt: 'work' },
    });
    expect(createDispatchEnvelope).toHaveBeenCalledOnce();
    expect(wrongTargetDispatcher).not.toHaveBeenCalled();
    expect(forwardTask).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ rulesPackDispatch: envelope }));
  });

  it('selects a deterministic Bridge dispatcher for a shared authenticated transport issuer', async () => {
    const envelope = { envelopeId: 'e', replayId: 'r', packDigest: 'd', issuer: 'bridge-credential' } as any;
    const source = (name: string, platform: string, issuer: string, dispatcher: ReturnType<typeof vi.fn>) => ({
      name,
      platform,
      config: { rulesPack: { dispatch: { issuer } } },
      bridge: { getRulesPackOperator: () => ({ createDispatchEnvelope: dispatcher }) },
    });
    const forwardTask = vi.fn(async () => ({
      success: true,
      rulesPackDelivery: { status: 'consumed', envelopeId: 'e', replayId: 'r', packDigest: 'd' },
    }));
    const base = {
      peerManager: { forwardTask } as any,
      peer: { name: 'savio', url: 'http://savio' },
      peerBot: {
        name: 'pm', engine: 'codex',
        rulesPackStatus: { state: 'inherited', required: true, mode: 'enforce', defaultProjectId: null },
      } as any,
      principal: { kind: 'generic', source: 'core-bearer', botName: 'bridge-credential' } as const,
      body: { botName: 'pm', chatId: 'chat-a', prompt: 'work' },
    };

    const exactDispatcher = vi.fn(async () => envelope);
    const adminDispatcher = vi.fn(async () => envelope);
    const otherDispatcher = vi.fn(async () => envelope);
    const exact = source('bridge-credential', 'web', 'bridge-credential', exactDispatcher);
    const admin = source('admin', 'web', 'bridge-credential', adminDispatcher);
    const other = source('alpha', 'web', 'bridge-credential', otherDispatcher);
    await forwardAuthenticatedPeerTask({
      ...base,
      registry: {
        get: (name: string) => name === 'bridge-credential' ? exact : name === 'admin' ? admin : undefined,
        listRegistered: () => [other, admin, exact],
      } as any,
    });
    expect(exactDispatcher).toHaveBeenCalledOnce();
    expect(adminDispatcher).not.toHaveBeenCalled();
    expect(otherDispatcher).not.toHaveBeenCalled();

    const wrongExactDispatcher = vi.fn(async () => envelope);
    const matchingAdminDispatcher = vi.fn(async () => envelope);
    const wrongExact = source('bridge-credential', 'web', 'different-issuer', wrongExactDispatcher);
    const matchingAdmin = source('admin', 'web', 'bridge-credential', matchingAdminDispatcher);
    await forwardAuthenticatedPeerTask({
      ...base,
      registry: {
        get: (name: string) => name === 'bridge-credential' ? wrongExact : name === 'admin' ? matchingAdmin : undefined,
        listRegistered: () => [other, wrongExact, matchingAdmin],
      } as any,
    });
    expect(matchingAdminDispatcher).toHaveBeenCalledOnce();
    expect(wrongExactDispatcher).not.toHaveBeenCalled();

    const alphaDispatcher = vi.fn(async () => envelope);
    const zuluDispatcher = vi.fn(async () => envelope);
    await forwardAuthenticatedPeerTask({
      ...base,
      registry: {
        get: () => undefined,
        listRegistered: () => [
          source('Zulu', 'web', 'bridge-credential', zuluDispatcher),
          source('alpha', 'web', 'bridge-credential', alphaDispatcher),
        ],
      } as any,
    });
    expect(alphaDispatcher).toHaveBeenCalledOnce();
    expect(zuluDispatcher).not.toHaveBeenCalled();

    const webDispatcher = vi.fn(async () => envelope);
    const feishuDispatcher = vi.fn(async () => envelope);
    const sameNameWeb = source('worker', 'web', 'bridge-credential', webDispatcher);
    const sameNameFeishu = source('worker', 'feishu', 'bridge-credential', feishuDispatcher);
    await forwardAuthenticatedPeerTask({
      ...base,
      registry: {
        get: () => undefined,
        listRegistered: () => [sameNameWeb, sameNameFeishu],
      } as any,
    });
    expect(feishuDispatcher).toHaveBeenCalledOnce();
    expect(webDispatcher).not.toHaveBeenCalled();

    await expect(forwardAuthenticatedPeerTask({
      ...base,
      registry: {
        get: () => undefined,
        listRegistered: () => [source('other', 'web', 'other-issuer', vi.fn(async () => envelope))],
      } as any,
    })).rejects.toThrow('source dispatcher is unavailable');
  });

  it('uses the exact trusted local bot operator for a scoped non-admin principal', async () => {
    const envelope = { envelopeId: 'e', replayId: 'r', packDigest: 'd', issuer: 'bridge-credential' } as any;
    const scopedDispatcher = vi.fn(async () => envelope);
    const transportNamedDispatcher = vi.fn(async () => envelope);
    const scopedBot = {
      name: 'pm',
      platform: 'web',
      config: { rulesPack: { dispatch: { issuer: 'bridge-credential' } } },
      bridge: { getRulesPackOperator: () => ({ createDispatchEnvelope: scopedDispatcher }) },
    };
    const transportNamedBot = {
      name: 'bridge-credential',
      platform: 'web',
      config: { rulesPack: { dispatch: { issuer: 'bridge-credential' } } },
      bridge: { getRulesPackOperator: () => ({ createDispatchEnvelope: transportNamedDispatcher }) },
    };
    const forwardTask = vi.fn(async () => ({
      success: true,
      rulesPackDelivery: { status: 'consumed', envelopeId: 'e', replayId: 'r', packDigest: 'd' },
    }));

    await forwardAuthenticatedPeerTask({
      registry: {
        get: (name: string) => name === 'pm' ? scopedBot : name === 'bridge-credential' ? transportNamedBot : undefined,
        listRegistered: () => [transportNamedBot, scopedBot],
      } as any,
      peerManager: { forwardTask } as any,
      peer: { name: 'savio', url: 'http://savio' },
      peerBot: {
        name: 'pm', engine: 'codex',
        rulesPackStatus: { state: 'inherited', required: true, mode: 'enforce', defaultProjectId: null },
      } as any,
      principal: {
        kind: 'scoped', source: 'capability', botName: 'pm', chatId: 'chat-a', roles: ['agent'],
      },
      body: { botName: 'pm', chatId: 'chat-a', prompt: 'work' },
    });

    expect(scopedDispatcher).toHaveBeenCalledOnce();
    expect(transportNamedDispatcher).not.toHaveBeenCalled();
    expect(forwardTask).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ rulesPackDispatch: envelope }));
  });

  it('fails closed when a required or enforce target has no source dispatcher', async () => {
    const forwardTask = vi.fn();
    for (const rulesPackStatus of [
      { state: 'inherited', required: true, mode: 'shadow' },
      { state: 'inherited', required: false, mode: 'enforce' },
    ] as const) {
      await expect(forwardAuthenticatedPeerTask({
        registry: { get: () => undefined, listRegistered: () => [] } as any,
        peerManager: { forwardTask } as any,
        peer: { name: 'savio', url: 'http://savio' },
        peerBot: { name: 'pm', engine: 'codex', rulesPackStatus } as any,
        principal: {
          kind: 'scoped', source: 'local-admin', botName: 'pm', chatId: 'chat-a', roles: ['api-admin'],
        },
        body: { botName: 'pm', chatId: 'chat-a', prompt: 'work' },
      })).rejects.toThrow('source dispatcher is unavailable');
    }
    expect(forwardTask).not.toHaveBeenCalled();
  });

  it('requires and preserves an exact shadowed acknowledgement from a shadow target', async () => {
    const envelope = { envelopeId: 'e', replayId: 'r', packDigest: 'd', issuer: 'caller' } as any;
    const recordDispatchRejected = vi.fn();
    const base = {
      registry: registryForIssuer('caller', {
        createDispatchEnvelope: async () => envelope,
        recordDispatchRejected,
      }),
      peer: { name: 'savio', url: 'http://savio' },
      peerBot: {
        name: 'pm', engine: 'codex',
        rulesPackStatus: { state: 'inherited', required: false, mode: 'shadow', defaultProjectId: null },
      } as any,
      principal: { kind: 'generic', source: 'core-bearer', botName: 'caller' } as const,
      body: { botName: 'pm', chatId: 'chat-a', prompt: 'work' },
    };
    const shadowed = await forwardAuthenticatedPeerTask({
      ...base,
      peerManager: { forwardTask: vi.fn(async () => ({
        success: true,
        rulesPackDelivery: { status: 'shadowed', envelopeId: 'e', replayId: 'r', packDigest: 'd' },
      })) } as any,
    });
    expect(shadowed).toMatchObject({ rulesPackDelivery: { status: 'shadowed' } });
    await expect(forwardAuthenticatedPeerTask({
      ...base,
      peerManager: { forwardTask: vi.fn(async () => ({
        success: true,
        rulesPackDelivery: { status: 'consumed', envelopeId: 'e', replayId: 'r', packDigest: 'd' },
      })) } as any,
    })).rejects.toThrow('exact shadowed acknowledgement');
    expect(recordDispatchRejected).toHaveBeenCalledOnce();
  });

  it('refuses to pretend a Codex peer accepted Rules when it reports opt-out', async () => {
    const forwardTask = vi.fn();
    await expect(forwardAuthenticatedPeerTask({
      registry: { get: () => ({ bridge: { getRulesPackOperator: () => ({}) } }) } as any,
      peerManager: { forwardTask } as any,
      peer: { name: 'savio', url: 'http://savio' },
      peerBot: {
        name: 'pm',
        engine: 'codex',
        rulesPackStatus: { state: 'opted-out', required: false, optOutReason: 'external policy' },
      } as any,
      principal: { kind: 'generic', source: 'core-bearer', botName: 'caller-bot' },
      body: { botName: 'pm', chatId: 'chat-a', prompt: 'work' },
    })).rejects.toThrow('is opted-out');
    expect(forwardTask).not.toHaveBeenCalled();
  });

  it.each(['claude', 'kimi'] as const)('rejects an explicit envelope sent to a %s peer', async (engine) => {
    const forwardTask = vi.fn(async () => ({ success: true }));
    await expect(forwardAuthenticatedPeerTask({
      registry: { get: () => undefined } as any,
      peerManager: { forwardTask } as any,
      peer: { name: 'legacy', url: 'http://legacy' },
      peerBot: { name: 'legacy', engine } as any,
      principal: { kind: 'generic', source: 'core-bearer' },
      body: {
        botName: 'legacy', chatId: 'chat', prompt: 'work',
        rulesPackDispatch: { envelopeId: 'e' } as any,
      },
    })).rejects.toThrow('requires a Codex target');
    expect(forwardTask).not.toHaveBeenCalled();
  });

  it.each([
    ['missing status', undefined, 'does not advertise support'],
    ['unconfigured', { state: 'unconfigured', required: false }, 'is unconfigured'],
    ['unsupported', { state: 'unsupported', required: false }, 'is unsupported'],
    ['opted out', { state: 'opted-out', required: false }, 'is opted-out'],
    ['off', { state: 'inherited', required: false, mode: 'off' }, 'is off'],
    ['missing live mode', { state: 'overridden', required: false }, 'does not advertise a live mode'],
  ])('fails closed before forwarding a Codex target with %s', async (_name, rulesPackStatus, message) => {
    const forwardTask = vi.fn();
    await expect(forwardAuthenticatedPeerTask({
      registry: { get: () => undefined, listRegistered: () => [] } as any,
      peerManager: { forwardTask } as any,
      peer: { name: 'savio', url: 'http://savio' },
      peerBot: { name: 'pm', engine: 'codex', ...(rulesPackStatus ? { rulesPackStatus } : {}) } as any,
      principal: { kind: 'generic', source: 'core-bearer', botName: 'caller' },
      body: { botName: 'pm', chatId: 'chat-a', prompt: 'work' },
    })).rejects.toThrow(message);
    expect(forwardTask).not.toHaveBeenCalled();
  });

  it('allows only optional shadow forwarding to proceed without a source operator', async () => {
    const forwardTask = vi.fn(async () => ({ success: true }));
    await expect(forwardAuthenticatedPeerTask({
      registry: { get: () => undefined, listRegistered: () => [] } as any,
      peerManager: { forwardTask } as any,
      peer: { name: 'savio', url: 'http://savio' },
      peerBot: {
        name: 'pm', engine: 'codex',
        rulesPackStatus: { state: 'inherited', required: false, mode: 'shadow', defaultProjectId: null },
      } as any,
      principal: { kind: 'generic', source: 'core-bearer', botName: 'caller' },
      body: { botName: 'pm', chatId: 'chat-a', prompt: 'work' },
    })).resolves.toEqual({ success: true });
    expect(forwardTask).toHaveBeenCalledOnce();
  });

  it('rejects off, legacy-unknown, and unacknowledged peer delivery', async () => {
    const envelope = { envelopeId: 'e', replayId: 'r', packDigest: 'd', issuer: 'caller' } as any;
    const base = {
      registry: registryForIssuer('caller', {
        createDispatchEnvelope: async () => envelope,
        recordDispatchRejected: vi.fn(),
      }),
      peerManager: { forwardTask: vi.fn(async () => ({ success: true })) } as any,
      peer: { name: 'savio', url: 'http://savio' },
      principal: { kind: 'generic', source: 'core-bearer', botName: 'caller' } as const,
      body: { botName: 'pm', chatId: 'chat-a', prompt: 'work' },
    };
    await expect(forwardAuthenticatedPeerTask({
      ...base,
      peerBot: { name: 'pm', engine: 'codex', rulesPackStatus: { state: 'inherited', required: true, mode: 'off' } } as any,
    })).rejects.toThrow('is off');
    await expect(forwardAuthenticatedPeerTask({
      ...base, peerBot: { name: 'pm', engine: 'codex' } as any,
    })).rejects.toThrow('does not advertise support');
    await expect(forwardAuthenticatedPeerTask({
      ...base,
      peerBot: {
        name: 'pm', engine: 'codex',
        rulesPackStatus: { state: 'inherited', required: true, mode: 'enforce' },
      } as any,
    })).rejects.toThrow('does not advertise its default project identity');
    await expect(forwardAuthenticatedPeerTask({
      ...base,
      peerBot: { name: 'pm', engine: 'codex', rulesPackStatus: { state: 'inherited', required: true, mode: 'enforce', defaultProjectId: null } } as any,
    })).rejects.toThrow('omitted the exact consumed acknowledgement');
  });

  it('fails closed on peer compile failure and records transport failure after envelope creation', async () => {
    const compileFailure = new Error('compile failed');
    const forwardTask = vi.fn();
    await expect(
      forwardAuthenticatedPeerTask({
        registry: registryForIssuer('caller-bot', {
          createDispatchEnvelope: () => {
            throw compileFailure;
          },
        }),
        peerManager: { forwardTask } as any,
        peer: { name: 'savio', url: 'http://savio' },
        peerBot: { name: 'pm', engine: 'codex', rulesPackStatus: { state: 'inherited', required: true, mode: 'enforce', defaultProjectId: null } } as any,
        principal: { kind: 'generic', source: 'core-bearer', botName: 'caller-bot' },
        body: { botName: 'pm', chatId: 'chat-a', prompt: 'work' },
      }),
    ).rejects.toThrow('compile failed');
    expect(forwardTask).not.toHaveBeenCalled();

    const envelope = { issuer: 'caller-bot' } as any;
    const recordDispatchRejected = vi.fn();
    await expect(
      forwardAuthenticatedPeerTask({
        registry: registryForIssuer('caller-bot', {
          createDispatchEnvelope: async () => envelope,
          recordDispatchRejected,
        }),
        peerManager: {
          forwardTask: vi.fn(async () => {
            throw new Error('transport failed');
          }),
        } as any,
        peer: { name: 'savio', url: 'http://savio' },
        peerBot: { name: 'pm', engine: 'codex', rulesPackStatus: { state: 'inherited', required: true, mode: 'enforce', defaultProjectId: null } } as any,
        principal: { kind: 'generic', source: 'core-bearer', botName: 'caller-bot' },
        body: { botName: 'pm', chatId: 'chat-a', prompt: 'work' },
      }),
    ).rejects.toThrow('transport failed');
    expect(recordDispatchRejected).toHaveBeenCalledWith(envelope, expect.any(Error));
  });

  it.each([
    [
      'direct non-2xx',
      { name: 'savio', url: 'http://savio' },
      () => Promise.reject(new Error('peer task failed with HTTP 503')),
    ],
    [
      'relay non-2xx',
      { name: 'savio', url: 'inbox:' },
      () => Promise.reject(new Error('core inbox enqueue failed with HTTP 503')),
    ],
    ['network throw', { name: 'savio', url: 'http://savio' }, () => Promise.reject(new Error('ECONNRESET'))],
    ['explicit JSON rejection', { name: 'savio', url: 'http://savio' }, () => Promise.resolve({ accepted: false })],
    ['explicit JSON error', { name: 'savio', url: 'http://savio' }, () => Promise.resolve({ error: 'rejected' })],
  ])('records a rejected receipt for envelope-bearing %s', async (_name, peer, implementation) => {
    const envelope = { issuer: 'caller-bot' } as any;
    const recordDispatchRejected = vi.fn();
    const operator = { createDispatchEnvelope: vi.fn(async () => envelope), recordDispatchRejected };
    await expect(
      forwardAuthenticatedPeerTask({
        registry: registryForIssuer('caller-bot', operator),
        peerManager: { forwardTask: vi.fn(implementation) } as any,
        peer: peer as any,
        peerBot: { name: 'pm', engine: 'codex', rulesPackStatus: { state: 'inherited', required: true, mode: 'enforce', defaultProjectId: null } } as any,
        principal: { kind: 'generic', source: 'core-bearer', botName: 'caller-bot' },
        body: { botName: 'pm', chatId: 'chat-a', prompt: 'work' },
      }),
    ).rejects.toThrow();
    expect(recordDispatchRejected).toHaveBeenCalledWith(envelope, expect.any(Error));
  });

  it.each([
    ['direct', { name: 'savio', url: 'http://savio' }],
    ['relay', { name: 'savio', url: 'inbox:' }],
  ])('does not record rejection for successful envelope-bearing %s delivery', async (_name, peer) => {
    const envelope = { envelopeId: 'e', replayId: 'r', packDigest: 'd', issuer: 'caller-bot' } as any;
    const recordDispatchRejected = vi.fn();
    const result = await forwardAuthenticatedPeerTask({
      registry: registryForIssuer('caller-bot', {
        createDispatchEnvelope: async () => envelope,
        recordDispatchRejected,
      }),
      peerManager: { forwardTask: vi.fn(async () => ({
        accepted: true,
        rulesPackDelivery: { status: 'consumed', envelopeId: 'e', replayId: 'r', packDigest: 'd' },
      })) } as any,
      peer: peer as any,
      peerBot: { name: 'pm', engine: 'codex', rulesPackStatus: { state: 'inherited', required: true, mode: 'enforce', defaultProjectId: null } } as any,
      principal: { kind: 'generic', source: 'core-bearer', botName: 'caller-bot' },
      body: { botName: 'pm', chatId: 'chat-a', prompt: 'work' },
    });
    expect(result).toEqual(peer.url === 'inbox:'
      ? {
          accepted: true,
          rulesPackDelivery: { status: 'queued', envelopeId: 'e', replayId: 'r', packDigest: 'd' },
        }
      : {
          accepted: true,
          rulesPackDelivery: { status: 'consumed', envelopeId: 'e', replayId: 'r', packDigest: 'd' },
        });
    expect(recordDispatchRejected).not.toHaveBeenCalled();
  });

  it('does not relabel an exact consumed acknowledgement as transport rejection after model failure', async () => {
    const envelope = { envelopeId: 'e', replayId: 'r', packDigest: 'd', issuer: 'caller-bot' } as any;
    const recordDispatchRejected = vi.fn();
    const result = await forwardAuthenticatedPeerTask({
      registry: registryForIssuer('caller-bot', {
        createDispatchEnvelope: async () => envelope,
        recordDispatchRejected,
      }),
      peerManager: { forwardTask: vi.fn(async () => ({
        success: false,
        error: 'model failed after stdin acceptance',
        rulesPackDelivery: { status: 'consumed', envelopeId: 'e', replayId: 'r', packDigest: 'd' },
      })) } as any,
      peer: { name: 'savio', url: 'http://savio' },
      peerBot: {
        name: 'pm', engine: 'codex',
        rulesPackStatus: { state: 'inherited', required: true, mode: 'enforce', defaultProjectId: null },
      } as any,
      principal: { kind: 'generic', source: 'core-bearer', botName: 'caller-bot' },
      body: { botName: 'pm', chatId: 'chat-a', prompt: 'work' },
    });
    expect(result).toMatchObject({ success: false, rulesPackDelivery: { status: 'consumed' } });
    expect(recordDispatchRejected).not.toHaveBeenCalled();
  });

  it('exposes authenticated bot-scoped status and mode controls through the operator', async () => {
    let bridgeState: any = {
      mode: 'off', operatorModeVersion: 0,
      operatorModeOverride: { mode: 'off', updatedAt: 'bridge-0' },
    };
    const operator = {
      status: vi.fn(() => ({ ...bridgeState })),
      compareAndSetMode: vi.fn((mode: string | null, expectedVersion: number, operationId: string) => {
        expect(expectedVersion).toBe(bridgeState.operatorModeVersion);
        bridgeState = {
          mode: mode ?? 'enforce',
          operatorModeVersion: expectedVersion + 1,
          operatorModeOperationId: operationId,
          ...(mode === null ? {} : { operatorModeOverride: { mode, updatedAt: 'bridge-next' } }),
        };
        return { ...bridgeState };
      }),
    };
    let workerStatus: any = {
      botName: 'admin',
      state: 'configured' as const,
      botScoped: true,
      mode: 'off' as const,
      configuredMode: 'enforce' as const,
      operatorModeOverride: { mode: 'off' as const, updatedAt: '2026-08-19T00:00:00.000Z' },
      operatorModeVersion: 0,
      appliesTo: 'subsequent-codex-policy-preparations' as const,
      inFlight: 'unchanged' as const,
    };
    const coordinator = {
      status: vi.fn(async () => ({ ...workerStatus })),
      setMode: vi.fn(async (
        _botName: string,
        mode: 'off' | 'shadow' | 'enforce' | null,
        expectedVersion: number,
        operationId: string,
      ) => {
        expect(expectedVersion).toBe(workerStatus.operatorModeVersion);
        workerStatus = {
          ...workerStatus,
          mode: mode ?? 'enforce',
          operatorModeVersion: expectedVersion + 1,
          operatorModeOperationId: operationId,
          ...(mode === null
            ? { operatorModeOverride: undefined }
            : { operatorModeOverride: { mode, updatedAt: '2026-08-19T00:00:01.000Z' } }),
        };
        return { ...workerStatus };
      }),
    };
    const updateLocalRulesPackStatus = vi.fn(async () => undefined);
    const ctx = {
      registry: {
        get: () => ({
          config: { claude: { defaultWorkingDirectory: '/tmp' } },
          bridge: { getRulesPackOperator: () => operator },
        }),
      },
      logger: {},
      ws: {},
      rulesPackWorkerCoordinator: coordinator,
      peerManager: { updateLocalRulesPackStatus },
    } as unknown as RouteContext;

    const status = response();
    expect(await handleBotRoutes(ctx, request(), status.res, 'GET', '/api/bots/admin/rulespack/status')).toBe(true);
    expect(status.output).toEqual({
      status: 200,
      body: {
        supported: true,
        state: 'overridden',
        required: false,
        mode: 'off',
        operatorModeVersion: 0,
        operatorModeOverride: { mode: 'off', updatedAt: 'bridge-0' },
        workerRulesPack: { coordination: 'confirmed', ...workerStatus },
      },
    });

    const mode = response();
    expect(
      await handleBotRoutes(ctx, request({ mode: 'shadow' }), mode.res, 'PATCH', '/api/bots/admin/rulespack/mode'),
    ).toBe(true);
    expect(operator.compareAndSetMode).toHaveBeenCalledWith('shadow', 0, expect.any(String));
    expect(coordinator.status).toHaveBeenCalledWith('admin');
    expect(coordinator.setMode).toHaveBeenCalledWith('admin', 'shadow', 0, expect.any(String));
    expect(updateLocalRulesPackStatus).toHaveBeenCalledWith('admin', expect.objectContaining({
      mode: 'shadow', operatorModeVersion: 1, operatorModeOperationId: expect.any(String),
    }));
    expect(mode.output).toMatchObject({
      status: 200,
      body: { mode: 'shadow', operatorModeVersion: 1, workerRulesPack: {
        coordination: 'confirmed', mode: 'shadow', operatorModeVersion: 1,
      } },
    });

    const cleared = response();
    await handleBotRoutes(ctx, request({ mode: null }), cleared.res, 'PATCH', '/api/bots/admin/rulespack/mode');
    expect(operator.compareAndSetMode).toHaveBeenLastCalledWith(null, 1, expect.any(String));
    expect(coordinator.setMode).toHaveBeenLastCalledWith('admin', null, 1, expect.any(String));
  });

  it('separates a failed Worker preflight from any mutation attempt', async () => {
    const operator = {
      status: vi.fn(() => ({ mode: 'enforce', operatorModeVersion: 0 })),
      compareAndSetMode: vi.fn(),
    };
    const ctx = {
      registry: {
        get: () => ({
          config: { claude: { defaultWorkingDirectory: '/tmp' } },
          bridge: { getRulesPackOperator: () => operator },
        }),
      },
      rulesPackWorkerCoordinator: {
        status: vi.fn(async () => { throw new Error('daemon unavailable'); }),
        setMode: vi.fn(),
      },
    } as unknown as RouteContext;
    const result = response();
    await handleBotRoutes(ctx, request({ mode: 'off' }), result.res, 'PATCH', '/api/bots/admin/rulespack/mode');
    expect(result.output).toMatchObject({
      status: 409,
      body: {
        code: 'WORKER_PREFLIGHT_FAILED', coordination: 'not-attempted',
        workerMutationAttempted: false, bridgeMutationAttempted: false,
      },
    });
    expect(operator.compareAndSetMode).not.toHaveBeenCalled();
  });

  it('does not confirm a mode change until versioned peer publication and a final Worker reread complete', async () => {
    let bridge: any = { mode: 'enforce', operatorModeVersion: 0 };
    let worker: any = {
      botName: 'admin', state: 'configured', botScoped: true, mode: 'enforce', configuredMode: 'enforce',
      operatorModeVersion: 0, appliesTo: 'subsequent-codex-policy-preparations', inFlight: 'unchanged',
    };
    let releasePublication: () => void = () => {};
    const publicationGate = new Promise<void>((resolve) => { releasePublication = resolve; });
    const coordinator = {
      status: vi.fn(async () => ({ ...worker })),
      setMode: vi.fn(async (_bot: string, mode: string | null, expected: number, operationId: string) => {
        worker = {
          ...worker, mode: mode ?? 'enforce', operatorModeVersion: expected + 1,
          operatorModeOperationId: operationId,
        };
        return { ...worker };
      }),
    };
    const operator = {
      status: vi.fn(() => ({ ...bridge })),
      compareAndSetMode: vi.fn((mode: string | null, expected: number, operationId: string) => {
        bridge = {
          mode: mode ?? 'enforce', operatorModeVersion: expected + 1,
          operatorModeOperationId: operationId,
        };
        return { ...bridge };
      }),
    };
    const updateLocalRulesPackStatus = vi.fn(async () => publicationGate);
    const ctx = {
      registry: { get: () => ({
        config: { claude: { defaultWorkingDirectory: '/tmp' } },
        bridge: { getRulesPackOperator: () => operator },
      }) },
      rulesPackWorkerCoordinator: coordinator,
      peerManager: { updateLocalRulesPackStatus },
    } as unknown as RouteContext;
    const result = response();
    const pending = handleBotRoutes(
      ctx, request({ mode: 'shadow' }), result.res, 'PATCH', '/api/bots/admin/rulespack/mode',
    );
    await vi.waitFor(() => expect(updateLocalRulesPackStatus).toHaveBeenCalledOnce());
    expect(result.output).toEqual({ status: 0 });
    expect(coordinator.status).toHaveBeenCalledTimes(2);
    releasePublication();
    await pending;
    expect(coordinator.status).toHaveBeenCalledTimes(3);
    expect(result.output).toMatchObject({ status: 200, body: { mode: 'shadow', operatorModeVersion: 1 } });
  });

  it('restores both surfaces and publishes the higher rollback generation when publication fails', async () => {
    let bridge: any = { mode: 'enforce', operatorModeVersion: 0 };
    let worker: any = {
      botName: 'admin', state: 'configured', botScoped: true, mode: 'enforce', configuredMode: 'enforce',
      operatorModeVersion: 0, appliesTo: 'subsequent-codex-policy-preparations', inFlight: 'unchanged',
    };
    const coordinator = {
      status: vi.fn(async () => ({ ...worker })),
      setMode: vi.fn(async (_bot: string, mode: string | null, expected: number, operationId: string) => {
        worker = {
          ...worker, mode: mode ?? 'enforce', operatorModeVersion: expected + 1,
          operatorModeOperationId: operationId,
          ...(mode === null ? { operatorModeOverride: undefined } : { operatorModeOverride: { mode, updatedAt: 'now' } }),
        };
        return { ...worker };
      }),
    };
    const operator = {
      status: vi.fn(() => ({ ...bridge })),
      compareAndSetMode: vi.fn((mode: string | null, expected: number, operationId: string) => {
        bridge = {
          mode: mode ?? 'enforce', operatorModeVersion: expected + 1,
          operatorModeOperationId: operationId,
          ...(mode === null ? { operatorModeOverride: undefined } : { operatorModeOverride: { mode, updatedAt: 'now' } }),
        };
        return { ...bridge };
      }),
    };
    const updateLocalRulesPackStatus = vi.fn()
      .mockRejectedValueOnce(new Error('Core unavailable'))
      .mockResolvedValueOnce(undefined);
    const ctx = {
      registry: { get: () => ({
        config: { claude: { defaultWorkingDirectory: '/tmp' } },
        bridge: { getRulesPackOperator: () => operator },
      }) },
      rulesPackWorkerCoordinator: coordinator,
      peerManager: { updateLocalRulesPackStatus },
    } as unknown as RouteContext;
    const result = response();
    await handleBotRoutes(ctx, request({ mode: 'off' }), result.res, 'PATCH', '/api/bots/admin/rulespack/mode');
    expect(result.output).toMatchObject({
      status: 500,
      body: { code: 'BRIDGE_MODE_UPDATE_FAILED', coordination: 'restored', bridgeRestored: true, workerRestored: true },
    });
    expect(updateLocalRulesPackStatus).toHaveBeenCalledTimes(2);
    expect(updateLocalRulesPackStatus.mock.calls[1][1]).toMatchObject({
      mode: 'enforce', operatorModeVersion: 2, operatorModeOperationId: expect.any(String),
    });
  });

  it('fences, restores, and confirms an unknown Worker mutation outcome before reporting failure', async () => {
    const operator = {
      status: vi.fn(() => ({ mode: 'enforce', operatorModeVersion: 0 })),
      compareAndSetMode: vi.fn(),
    };
    let worker: any = {
      botName: 'admin', state: 'configured', botScoped: true, mode: 'enforce', configuredMode: 'enforce',
      operatorModeVersion: 0, appliesTo: 'subsequent-codex-policy-preparations', inFlight: 'unchanged',
    };
    const coordinator = {
      status: vi.fn(async () => ({ ...worker })),
      setMode: vi.fn(async (
        _botName: string, mode: string | null, expectedVersion: number, operationId: string,
      ) => {
        expect(expectedVersion).toBe(worker.operatorModeVersion);
        worker = {
          ...worker,
          mode: mode ?? 'enforce',
          operatorModeVersion: expectedVersion + 1,
          operatorModeOperationId: operationId,
          ...(mode === null ? { operatorModeOverride: undefined } : { operatorModeOverride: { mode, updatedAt: 'now' } }),
        };
        throw new Error('connection lost after commit');
      }),
    };
    const ctx = {
      registry: { get: () => ({
        config: { claude: { defaultWorkingDirectory: '/tmp' } },
        bridge: { getRulesPackOperator: () => operator },
      }) },
      rulesPackWorkerCoordinator: coordinator,
    } as unknown as RouteContext;
    const result = response();
    await handleBotRoutes(ctx, request({ mode: 'off' }), result.res, 'PATCH', '/api/bots/admin/rulespack/mode');
    expect(result.output).toMatchObject({
      status: 409,
      body: { code: 'WORKER_MUTATION_FAILED', coordination: 'restored', workerRestored: true },
    });
    expect(worker).toMatchObject({ mode: 'enforce', operatorModeVersion: 2 });
    expect(operator.compareAndSetMode).not.toHaveBeenCalled();
  });

  it('reports indeterminate and does not overwrite a different concurrent Worker operation', async () => {
    const operator = {
      status: vi.fn(() => ({ mode: 'enforce', operatorModeVersion: 0 })),
      compareAndSetMode: vi.fn(),
    };
    let worker: any = {
      botName: 'admin', state: 'configured', botScoped: true, mode: 'enforce', configuredMode: 'enforce',
      operatorModeVersion: 0, appliesTo: 'subsequent-codex-policy-preparations', inFlight: 'unchanged',
    };
    const coordinator = {
      status: vi.fn(async () => ({ ...worker })),
      setMode: vi.fn(async () => {
        worker = { ...worker, mode: 'shadow', operatorModeVersion: 2, operatorModeOperationId: 'other-operation' };
        throw new Error('invalid acknowledgement');
      }),
    };
    const ctx = {
      registry: { get: () => ({
        config: { claude: { defaultWorkingDirectory: '/tmp' } },
        bridge: { getRulesPackOperator: () => operator },
      }) },
      rulesPackWorkerCoordinator: coordinator,
    } as unknown as RouteContext;
    const result = response();
    await handleBotRoutes(ctx, request({ mode: 'off' }), result.res, 'PATCH', '/api/bots/admin/rulespack/mode');
    expect(result.output).toMatchObject({
      status: 500,
      body: { code: 'RULESPACK_COORDINATION_INDETERMINATE', coordination: 'indeterminate' },
    });
    expect(result.output.body).not.toHaveProperty('bridgeModeUnchanged');
    expect(coordinator.setMode).toHaveBeenCalledTimes(1);
    expect(operator.compareAndSetMode).not.toHaveBeenCalled();
  });

  it('refuses a 200 and restores Bridge when Worker changes before final two-surface confirmation', async () => {
    let bridge: any = { mode: 'enforce', operatorModeVersion: 0 };
    let worker: any = {
      botName: 'admin', state: 'configured', botScoped: true, mode: 'enforce', configuredMode: 'enforce',
      operatorModeVersion: 0, appliesTo: 'subsequent-codex-policy-preparations', inFlight: 'unchanged',
    };
    let statusReads = 0;
    const coordinator = {
      status: vi.fn(async () => {
        statusReads += 1;
        if (statusReads === 2) {
          worker = {
            ...worker, mode: 'shadow', operatorModeVersion: 2,
            operatorModeOperationId: 'other-successful-operation',
            operatorModeOverride: { mode: 'shadow', updatedAt: 'external' },
          };
        }
        return { ...worker };
      }),
      setMode: vi.fn(async (_botName: string, mode: string | null, expectedVersion: number, operationId: string) => {
        worker = {
          ...worker, mode: mode ?? 'enforce', operatorModeVersion: expectedVersion + 1,
          operatorModeOperationId: operationId,
          ...(mode === null ? {} : { operatorModeOverride: { mode, updatedAt: 'ours' } }),
        };
        return { ...worker };
      }),
    };
    const operator = {
      status: vi.fn(() => ({ ...bridge })),
      compareAndSetMode: vi.fn((mode: string | null, expectedVersion: number, operationId: string) => {
        bridge = {
          mode: mode ?? 'enforce', operatorModeVersion: expectedVersion + 1,
          operatorModeOperationId: operationId,
          ...(mode === null ? {} : { operatorModeOverride: { mode, updatedAt: 'ours' } }),
        };
        return { ...bridge };
      }),
    };
    const ctx = {
      registry: { get: () => ({
        config: { claude: { defaultWorkingDirectory: '/tmp' } },
        bridge: { getRulesPackOperator: () => operator },
      }) },
      rulesPackWorkerCoordinator: coordinator,
    } as unknown as RouteContext;
    const result = response();
    await handleBotRoutes(ctx, request({ mode: 'off' }), result.res, 'PATCH', '/api/bots/admin/rulespack/mode');
    expect(result.output).toMatchObject({
      status: 500,
      body: {
        code: 'RULESPACK_COORDINATION_INDETERMINATE', coordination: 'indeterminate',
        bridgeRestored: true, workerRestored: false,
      },
    });
    expect(bridge).toMatchObject({ mode: 'enforce', operatorModeVersion: 2 });
    expect(worker).toMatchObject({ mode: 'shadow', operatorModeOperationId: 'other-successful-operation' });
    expect(coordinator.setMode).toHaveBeenCalledTimes(1);
  });

  it('compensates both surfaces when the later Bridge update fails', async () => {
    const operator = {
      status: vi.fn(() => ({ mode: 'enforce', operatorModeVersion: 0 })),
      compareAndSetMode: vi.fn(() => { throw new Error('bridge database busy'); }),
    };
    let worker: any = {
      botName: 'admin', state: 'configured' as const, botScoped: true,
      mode: 'enforce' as const, configuredMode: 'enforce' as const,
      operatorModeVersion: 0,
      appliesTo: 'subsequent-codex-policy-preparations' as const, inFlight: 'unchanged' as const,
    };
    const coordinator = {
      status: vi.fn(async () => ({ ...worker })),
      setMode: vi.fn(async (_botName: string, mode: string | null, expectedVersion: number, operationId: string) => {
        worker = {
          ...worker, mode: mode ?? 'enforce', operatorModeVersion: expectedVersion + 1,
          operatorModeOperationId: operationId,
          ...(mode === null ? { operatorModeOverride: undefined } : { operatorModeOverride: { mode, updatedAt: 'now' } }),
        };
        return { ...worker };
      }),
    };
    const ctx = {
      registry: { get: () => ({
        config: { claude: { defaultWorkingDirectory: '/tmp' } },
        bridge: { getRulesPackOperator: () => operator },
      }) },
      rulesPackWorkerCoordinator: coordinator,
    } as unknown as RouteContext;
    const result = response();
    await handleBotRoutes(ctx, request({ mode: 'off' }), result.res, 'PATCH', '/api/bots/admin/rulespack/mode');
    expect(result.output).toMatchObject({
      status: 500,
      body: { code: 'BRIDGE_MODE_UPDATE_FAILED', coordination: 'restored', workerRestored: true, bridgeRestored: true },
    });
    expect(coordinator.setMode).toHaveBeenCalledTimes(2);
    expect(coordinator.setMode.mock.calls[0]).toEqual(['admin', 'off', 0, expect.any(String)]);
    expect(coordinator.setMode.mock.calls[1]).toEqual(['admin', null, 1, expect.any(String)]);
  });

  it('serializes concurrent PATCH flows for one bot and advances both CAS versions in order', async () => {
    let bridge: any = { mode: 'enforce', operatorModeVersion: 0 };
    let worker: any = {
      botName: 'admin', state: 'configured', botScoped: true, mode: 'enforce', configuredMode: 'enforce',
      operatorModeVersion: 0, appliesTo: 'subsequent-codex-policy-preparations', inFlight: 'unchanged',
    };
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let mutationCount = 0;
    const coordinator = {
      status: vi.fn(async () => ({ ...worker })),
      setMode: vi.fn(async (_botName: string, mode: string | null, expectedVersion: number, operationId: string) => {
        mutationCount += 1;
        if (mutationCount === 1) await firstGate;
        expect(expectedVersion).toBe(worker.operatorModeVersion);
        worker = {
          ...worker, mode: mode ?? 'enforce', operatorModeVersion: expectedVersion + 1,
          operatorModeOperationId: operationId,
          ...(mode === null ? {} : { operatorModeOverride: { mode, updatedAt: 'now' } }),
        };
        return { ...worker };
      }),
    };
    const operator = {
      status: vi.fn(() => ({ ...bridge })),
      compareAndSetMode: vi.fn((mode: string | null, expectedVersion: number, operationId: string) => {
        expect(expectedVersion).toBe(bridge.operatorModeVersion);
        bridge = {
          mode: mode ?? 'enforce', operatorModeVersion: expectedVersion + 1,
          operatorModeOperationId: operationId,
          ...(mode === null ? {} : { operatorModeOverride: { mode, updatedAt: 'now' } }),
        };
        return { ...bridge };
      }),
    };
    const ctx = {
      registry: { get: () => ({
        config: { claude: { defaultWorkingDirectory: '/tmp' } },
        bridge: { getRulesPackOperator: () => operator },
      }) },
      rulesPackWorkerCoordinator: coordinator,
    } as unknown as RouteContext;
    const first = response();
    const second = response();
    const firstRequest = handleBotRoutes(
      ctx, request({ mode: 'off' }), first.res, 'PATCH', '/api/bots/admin/rulespack/mode',
    );
    await vi.waitFor(() => expect(coordinator.setMode).toHaveBeenCalledTimes(1));
    const secondRequest = handleBotRoutes(
      ctx, request({ mode: 'shadow' }), second.res, 'PATCH', '/api/bots/admin/rulespack/mode',
    );
    await Promise.resolve();
    expect(coordinator.status).toHaveBeenCalledTimes(1);
    releaseFirst();
    await Promise.all([firstRequest, secondRequest]);
    expect(first.output.status).toBe(200);
    expect(second.output.status).toBe(200);
    expect(worker).toMatchObject({ mode: 'shadow', operatorModeVersion: 2 });
    expect(bridge).toMatchObject({ mode: 'shadow', operatorModeVersion: 2 });
    expect(coordinator.setMode.mock.calls.map((call) => call.slice(1, 3))).toEqual([
      ['off', 0], ['shadow', 1],
    ]);
  });

  it('returns visible unsupported and audited opt-out status without an operator', async () => {
    const ctx = {
      registry: {
        get: (name: string) => name === 'kimi'
          ? { config: { engine: 'kimi', claude: { defaultWorkingDirectory: '/tmp' } }, bridge: {} }
          : {
              config: {
                engine: 'codex',
                rulesPackPolicy: { state: 'opted-out', required: false, optOutReason: 'external policy' },
                claude: { defaultWorkingDirectory: '/tmp' },
              },
              bridge: {},
            },
      },
    } as unknown as RouteContext;
    const optedOut = response();
    await handleBotRoutes(ctx, request(), optedOut.res, 'GET', '/api/bots/admin/rulespack/status');
    expect(optedOut.output).toEqual({
      status: 200,
      body: {
        supported: true,
        state: 'opted-out',
        required: false,
        optOutReason: 'external policy',
        initialized: false,
        mode: 'off',
      },
    });
    const unsupported = response();
    await handleBotRoutes(ctx, request(), unsupported.res, 'GET', '/api/bots/kimi/rulespack/status');
    expect(unsupported.output.body).toMatchObject({ supported: false, state: 'unsupported', mode: 'off' });
  });

  it('rejects a dispatch whose claimed issuer is not bound by authenticated transport', async () => {
    const ctx = {
      resolveRulesPackTransportIssuer: () => 'authenticated-peer',
    } as unknown as RouteContext;
    const { res, output } = response();
    const handled = await handleTaskRoutes(
      ctx,
      request(
        { botName: 'admin', chatId: 'chat', prompt: 'work', rulesPackDispatch: {} },
        { 'x-metabot-origin': 'peer', 'x-metabot-rulespack-issuer': 'spoofed-peer' },
      ),
      res,
      'POST',
      '/api/talk',
    );
    expect(handled).toBe(true);
    expect(output).toEqual({
      status: 400,
      body: { error: 'RulesPack dispatch requires authenticated peer transport headers' },
    });
  });
});
