import { describe, expect, it } from 'vitest';
import {
  AgentTeamCapabilityError,
  AgentTeamExecutionCapabilityService,
} from '../src/agent-teams/governance-capability.js';

describe('AgentTeamExecutionCapabilityService', () => {
  it('verifies signed principal scope and rejects spoofed, missing, and expired credentials', () => {
    const service = new AgentTeamExecutionCapabilityService('test-signing-key');
    const token = service.issue(
      {
        role: 'manager',
        botName: 'pm-codex',
        chatId: 'teaminst:one:lead',
        teamName: 'atg-one',
        agentName: 'lead',
        ttlMs: 1_000,
      },
      10_000,
    );

    expect(service.verify(token, { botName: 'pm-codex', chatId: 'teaminst:one:lead' }, 10_500)).toMatchObject({
      role: 'manager',
      teamName: 'atg-one',
      agentName: 'lead',
      source: 'execution-capability',
    });
    const liveToken = service.issue({
      role: 'manager',
      botName: 'pm-codex',
      chatId: 'teaminst:one:lead',
      teamName: 'atg-one',
      agentName: 'lead',
      ttlMs: 60_000,
    });
    expect(
      service.resolve({
        capability: liveToken,
        botName: 'pm-codex',
        chatId: 'teaminst:one:lead',
        localApiSecretAuthenticated: false,
      }),
    ).toMatchObject({
      role: 'manager',
      teamName: 'atg-one',
      source: 'execution-capability',
    });
    expect(() => service.verify(token, { botName: 'spoofed', chatId: 'teaminst:one:lead' }, 10_500)).toThrowError(
      AgentTeamCapabilityError,
    );
    expect(() =>
      service.verify(`${token.slice(0, -1)}x`, { botName: 'pm-codex', chatId: 'teaminst:one:lead' }, 10_500),
    ).toThrowError(AgentTeamCapabilityError);
    expectCapabilityCode(
      () => service.verify(token, { botName: 'pm-codex', chatId: 'teaminst:one:lead' }, 11_000),
      'EXECUTION_CAPABILITY_EXPIRED',
    );
    expectCapabilityCode(
      () =>
        service.resolve({
          botName: 'pm-codex',
          chatId: 'teaminst:one:lead',
          localApiSecretAuthenticated: true,
        }),
      'EXECUTION_CAPABILITY_REQUIRED',
    );
    expect(service.resolve({ localApiSecretAuthenticated: true })).toMatchObject({
      role: 'admin',
      source: 'local-api-secret',
    });
  });
});

function expectCapabilityCode(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error('Expected AgentTeamCapabilityError');
  } catch (error) {
    expect(error).toBeInstanceOf(AgentTeamCapabilityError);
    expect(error).toMatchObject({ code });
  }
}
