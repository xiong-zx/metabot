import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuleInputV1 } from '@metabot/rulespack';
import type { BotConfigBase } from '../src/config.js';
import { MessageBridge } from '../src/bridge/message-bridge.js';
import { NullSender } from '../src/web/null-sender.js';

const logger = {
  child: () => logger,
  debug() {},
  info() {},
  warn() {},
  error() {},
} as any;

const created: string[] = [];
const originalSessionStore = process.env.SESSION_STORE_DIR;
const originalCapture = process.env.RULESPACK_SMOKE_CAPTURE;

afterEach(() => {
  if (originalSessionStore === undefined) delete process.env.SESSION_STORE_DIR;
  else process.env.SESSION_STORE_DIR = originalSessionStore;
  if (originalCapture === undefined) delete process.env.RULESPACK_SMOKE_CAPTURE;
  else process.env.RULESPACK_SMOKE_CAPTURE = originalCapture;
  for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function rule(id: string, text: string): RuleInputV1 {
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
    source: { kind: 'config', adapterId: 'ignored', ref: 'smoke', revision: '1' },
  };
}

describe('RulesPack in-process MetaBot smoke', () => {
  it('injects once, reuses unchanged sessions, and recycles on changed/off digests', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'metabot-rulespack-smoke-'));
    created.push(directory);
    const executable = join(directory, 'fake-codex.mjs');
    const capture = join(directory, 'capture.json');
    writeFileSync(
      executable,
      `#!/usr/bin/env node
import fs from 'node:fs';
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk.toString('utf8');
fs.writeFileSync(process.env.RULESPACK_SMOKE_CAPTURE, JSON.stringify({args: process.argv.slice(2), prompt}));
console.log(JSON.stringify({type:'thread.started',thread_id:'thread-rulespack'}));
console.log(JSON.stringify({type:'item.completed',item:{id:'msg-1',type:'agent_message',text:'done'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));
`,
    );
    chmodSync(executable, 0o755);
    process.env.SESSION_STORE_DIR = directory;
    process.env.RULESPACK_SMOKE_CAPTURE = capture;

    const config: BotConfigBase = {
      name: 'admin',
      engine: 'codex',
      codex: { executable, model: 'test-model' },
      rulesPack: {
        mode: 'enforce',
        hostId: 'imac',
        dbPath: join(directory, 'rules-state.sqlite'),
        configRules: { id: 'smoke-config', revision: '1', rules: [rule('base', 'Apply the smoke policy.')] },
        projectBindings: [{ projectId: 'smoke-project', root: directory }],
        dispatch: {
          issuer: 'metabot-host:imac',
          audience: 'metabot-host:imac',
          allowedIssuers: ['metabot-host:imac'],
        },
      },
      rulesPackPolicy: { state: 'inherited', required: true },
      claude: {
        defaultWorkingDirectory: directory,
        maxTurns: undefined,
        maxBudgetUsd: undefined,
        model: undefined,
        apiKey: undefined,
        outputsBaseDir: join(directory, 'outputs'),
        downloadsDir: join(directory, 'downloads'),
        backend: 'pty',
      },
    };
    const bridge = new MessageBridge(config, logger, new NullSender());
    try {
      await expect(bridge.executeApiTask({
        prompt: 'Must not run without an exact principal.',
        chatId: 'generic-bearer',
        sendCards: false,
        rulesPack: { principal: { kind: 'generic', source: 'core-bearer' } },
      })).rejects.toThrow('missing or unscoped transport principal');
      await expect(bridge.executeApiTask({
        prompt: 'Must not switch away from the required policy engine.',
        chatId: 'unsupported-engine',
        sendCards: false,
        engine: 'kimi',
      })).rejects.toThrow('supports Codex only');
      const dispatchFacts = {
        botName: 'admin',
        chatId: 'dispatch-smoke',
        roles: ['peer'],
        cwd: directory,
        userId: 'peer-user',
        agentName: 'agent-a',
        workerId: 'worker-a',
        projectId: 'smoke-project',
        taskId: 'task-a',
        tools: [],
        dataClasses: ['agent-bus', 'worker'],
        outputTypes: ['json'],
      };
      const envelope = await bridge.getRulesPackOperator()!.createDispatchEnvelope({
        facts: dispatchFacts,
        audience: 'metabot-host:imac',
      });
      const dispatched = await bridge.executeApiTask({
        prompt: 'Consume the authenticated dispatch.',
        chatId: 'dispatch-smoke',
        sendCards: false,
        rulesPack: {
          principal: {
            kind: 'scoped',
            source: 'agent-bus',
            botName: 'admin',
            chatId: 'dispatch-smoke',
            roles: ['peer'],
            userId: 'peer-user',
            agentName: 'agent-a',
            workerId: 'worker-a',
            projectId: 'smoke-project',
            taskId: 'task-a',
            tools: [],
            dataClasses: ['agent-bus', 'worker'],
            outputTypes: ['json'],
          },
          dispatch: { envelope, authenticatedIssuer: 'metabot-host:imac' },
        },
      });
      expect(dispatched.rulesPackDelivery).toEqual({
        status: 'consumed',
        envelopeId: envelope.envelopeId,
        replayId: envelope.replayId,
        packDigest: envelope.packDigest,
        effectivePackDigest: expect.stringMatching(/^sha256:/u),
      });
      const run = () => bridge.executeApiTask({ prompt: 'Do the smoke task.', chatId: 'chat-smoke', sendCards: false });
      expect((await run()).success).toBe(true);
      let invocation = JSON.parse(readFileSync(capture, 'utf8')) as { args: string[]; prompt: string };
      expect(invocation.args).not.toContain('resume');
      expect(invocation.args.at(-1)).toBe('-');
      expect(invocation.args).not.toContain(invocation.prompt);
      expect(invocation.prompt.indexOf('Apply the smoke policy.')).toBeLessThan(
        invocation.prompt.indexOf('Do the smoke task.'),
      );

      expect((await run()).success).toBe(true);
      invocation = JSON.parse(readFileSync(capture, 'utf8')) as { args: string[]; prompt: string };
      expect(invocation.args).toContain('resume');
      expect(invocation.args.at(-1)).toBe('-');
      expect(invocation.args).not.toContain(invocation.prompt);

      await bridge.getRulesPackOperator()!.replaceTemporaryRules({
        sourceId: 'temporary-smoke',
        revision: '1',
        rules: [
          {
            ...rule('temporary', 'Apply the changed temporary policy.'),
            authority: 'user-current',
            lifecycle: { status: 'approved', expiresAt: new Date(Date.now() + 60_000).toISOString() },
            source: { kind: 'temporary', adapterId: 'temporary-smoke', ref: 'smoke', revision: '1' },
          },
        ],
        authenticatedFacts: {
          botName: 'admin',
          chatId: 'chat-smoke',
          roles: ['internal-api'],
          cwd: directory,
          userId: 'api',
          tools: [],
          dataClasses: ['api'],
          outputTypes: ['text'],
        },
      });
      expect((await run()).success).toBe(true);
      invocation = JSON.parse(readFileSync(capture, 'utf8')) as { args: string[]; prompt: string };
      expect(invocation.args).not.toContain('resume');
      expect(invocation.args.at(-1)).toBe('-');
      expect(invocation.prompt).toContain('Apply the changed temporary policy.');

      bridge.getRulesPackOperator()!.setMode('off');
      expect((await run()).success).toBe(true);
      invocation = JSON.parse(readFileSync(capture, 'utf8')) as { args: string[]; prompt: string };
      expect(invocation.args).not.toContain('resume');
      expect(invocation.args.at(-1)).toBe('-');
      expect(invocation.prompt).not.toContain('RULESPACK DATA');
    } finally {
      await bridge.destroyAsync();
    }
  });
});
