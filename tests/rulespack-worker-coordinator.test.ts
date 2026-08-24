import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LocalRulesPackWorkerCoordinator,
  RulesPackWorkerCoordinationError,
} from '../src/extensions/rulespack-worker-coordinator.js';

afterEach(() => vi.unstubAllGlobals());

describe('RulesPack Worker coordinator', () => {
  it('uses a short-lived lifecycle capability and requires a durable bot-scoped acknowledgement', async () => {
    const issueLocalLifecycleAdmin = vi.fn(() => 'signed');
    const fetchMock = vi.fn(async (_url: URL | string, _init?: RequestInit) => new Response(JSON.stringify({
      botName: 'pm/a',
      state: 'configured',
      botScoped: true,
      mode: 'off',
      configuredMode: 'enforce',
      operatorModeOverride: { mode: 'off', updatedAt: '2026-08-19T00:00:00.000Z' },
      operatorModeVersion: 1,
      operatorModeOperationId: 'operation-1',
      appliesTo: 'subsequent-codex-policy-preparations',
      inFlight: 'unchanged',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const coordinator = new LocalRulesPackWorkerCoordinator({
      capabilityService: { issueLocalLifecycleAdmin } as any,
      endpoint: 'http://127.0.0.1:9311/mcp',
    });

    await expect(coordinator.setMode('pm/a', 'off', 0, 'operation-1')).resolves.toMatchObject({
      botName: 'pm/a', mode: 'off', operatorModeOverride: { mode: 'off' },
    });
    expect(issueLocalLifecycleAdmin).toHaveBeenCalledWith('worker');
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'http://127.0.0.1:9311/mcp/rulespack/bots/pm%2Fa/mode',
    );
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: 'PATCH',
      headers: { authorization: 'Bearer signed' },
      body: JSON.stringify({ mode: 'off', expectedVersion: 0, operationId: 'operation-1' }),
    });
  });

  it('rejects a success-shaped response that did not persist the requested override', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      botName: 'admin',
      state: 'configured',
      botScoped: true,
      mode: 'off',
      configuredMode: 'enforce',
      operatorModeVersion: 1,
      operatorModeOperationId: 'operation-2',
      appliesTo: 'subsequent-codex-policy-preparations',
      inFlight: 'unchanged',
    }), { status: 200 })));
    const coordinator = new LocalRulesPackWorkerCoordinator({
      capabilityService: { issueLocalLifecycleAdmin: () => 'signed' } as any,
    });
    await expect(coordinator.setMode('admin', 'off', 0, 'operation-2')).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    } satisfies Partial<RulesPackWorkerCoordinationError>);
  });

  it('refuses any non-loopback daemon endpoint', () => {
    expect(() => new LocalRulesPackWorkerCoordinator({
      capabilityService: {} as any,
      endpoint: 'https://worker.example.test/mcp',
    })).toThrow('loopback HTTP');
  });
});
