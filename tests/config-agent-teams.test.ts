import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadAppConfig } from '../src/config.js';

const originalBotsConfig = process.env.BOTS_CONFIG;

afterEach(() => {
  if (originalBotsConfig === undefined) delete process.env.BOTS_CONFIG;
  else process.env.BOTS_CONFIG = originalBotsConfig;
});

describe('Agent Team config loading', () => {
  it('preserves runtime template fields supported by the Agent Team store', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-agent-team-config-'));
    const configPath = path.join(dir, 'bots.json');
    fs.writeFileSync(configPath, JSON.stringify({
      webBots: [
        {
          name: 'web-admin',
          defaultWorkingDirectory: '/root/metabot',
        },
      ],
      agentTeams: [
        {
          name: 'research-codex',
          description: 'Research team',
          status: 'active',
          chatIds: ['oc_project'],
          displayChatIds: ['oc_project'],
          managedByConfig: true,
          templateName: 'research-codex',
          templateVersion: 3,
          templateDigest: 'abc123',
          scopeType: 'chat',
          scopeKey: 'oc_project',
          instanceId: 'ati_oc_project',
          pmBot: 'pm-codex',
          quotas: {
            maxAgents: 7,
            maxTemporaryAgents: 2,
            maxParallelRunsPerAgent: 1,
            maxTeamsPerScope: 2,
            maxQueuedTasks: 12,
            maxActiveRuns: 4,
          },
          ruleSetRefs: ['global-dev@2', { name: 'project-rules', version: 5 }],
          agents: [
            {
              name: 'manager',
              role: 'manager',
              engine: 'codex',
              model: 'gpt-5.5',
              reasoningEffort: 'xhigh',
              approvalPolicy: 'never',
              sandbox: 'workspace-write',
              timeoutMs: 120_000,
              idleTimeoutMs: 30_000,
              allowedTools: ['Read', 'Edit'],
              prompt: 'Coordinate only.',
              sessionId: 'sess-manager',
              status: 'idle',
              kind: 'temporary',
              createdBy: 'pm',
              ttlMs: 60_000,
              expiresAt: 1_900_000_000_000,
              promotionStatus: 'proposed',
            },
          ],
        },
      ],
    }), 'utf-8');
    process.env.BOTS_CONFIG = configPath;

    const config = loadAppConfig();
    const team = config.agentTeams[0];
    expect(team).toMatchObject({
      name: 'research-codex',
      managedByConfig: true,
      templateName: 'research-codex',
      templateVersion: 3,
      templateDigest: 'abc123',
      scopeType: 'chat',
      scopeKey: 'oc_project',
      instanceId: 'ati_oc_project',
      pmBot: 'pm-codex',
      quotas: {
        maxAgents: 7,
        maxTemporaryAgents: 2,
        maxParallelRunsPerAgent: 1,
        maxTeamsPerScope: 2,
        maxQueuedTasks: 12,
        maxActiveRuns: 4,
      },
      ruleSetRefs: ['global-dev@2', { name: 'project-rules', version: 5 }],
    });
    expect(team.agents?.[0]).toMatchObject({
      name: 'manager',
      kind: 'temporary',
      createdBy: 'pm',
      ttlMs: 60_000,
      expiresAt: 1_900_000_000_000,
      promotionStatus: 'proposed',
    });
  });
});
