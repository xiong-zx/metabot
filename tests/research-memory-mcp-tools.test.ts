import { describe, expect, it, vi } from 'vitest';
import { callResearchMemoryMcpTool, isResearchMemoryMcpTool } from '../src/mcp/research-memory-mcp-tools.js';

describe('research memory MCP tools', () => {
  it('detects registered research-memory tools', () => {
    expect(isResearchMemoryMcpTool('memory_search')).toBe(true);
    expect(isResearchMemoryMcpTool('worker_dispatch')).toBe(false);
  });

  it('logs memory events through the bridge API', async () => {
    const apiRequest = vi.fn(async () => ({ status: 201, data: { event: { id: 'mem_evt_1' } } }));

    const result = await callResearchMemoryMcpTool(
      'memory_log_event',
      {
        root: '/repo',
        type: 'decision',
        summary: 'Use MCP memory facade',
        projectId: 'proj-alpha',
        domain: 'metabot',
      },
      apiRequest,
    );

    expect(apiRequest).toHaveBeenCalledWith('POST', '/api/research-memory/events', {
      root: '/repo',
      event: {
        type: 'decision',
        summary: 'Use MCP memory facade',
        actor: { kind: 'agent', id: 'mcp' },
        scope: { project_id: 'proj-alpha', domain: 'metabot', visibility: 'project' },
      },
    });
    expect(result.content[0]!.text).toContain('mem_evt_1');
  });

  it('maps fact memory log shorthand to finding', async () => {
    const apiRequest = vi.fn(async () => ({ status: 201, data: { event: { id: 'mem_evt_fact' } } }));

    await callResearchMemoryMcpTool(
      'memory_log_event',
      {
        root: '/repo',
        type: 'fact',
        summary: 'Smoke fact',
        projectId: 'proj-alpha',
      },
      apiRequest,
    );

    expect(apiRequest).toHaveBeenCalledWith('POST', '/api/research-memory/events', {
      root: '/repo',
      event: {
        type: 'finding',
        summary: 'Smoke fact',
        actor: { kind: 'agent', id: 'mcp' },
        scope: { project_id: 'proj-alpha', visibility: 'project' },
      },
    });
  });

  it('searches memory with query params', async () => {
    const apiRequest = vi.fn(async () => ({ status: 200, data: { results: [] } }));

    await callResearchMemoryMcpTool(
      'memory_search',
      { root: '/repo', query: 'negative result', projectId: 'proj-alpha', limit: 3 },
      apiRequest,
    );

    expect(apiRequest).toHaveBeenCalledWith(
      'GET',
      '/api/research-memory/search?root=%2Frepo&q=negative+result&projectId=proj-alpha&limit=3',
    );
  });

  it('lists run lifecycle records and artifacts', async () => {
    const apiRequest = vi.fn(async () => ({ status: 200, data: { ok: true } }));

    await callResearchMemoryMcpTool('memory_runs', { root: '/repo', projectId: 'proj-alpha' }, apiRequest);
    await callResearchMemoryMcpTool('memory_artifacts', { root: '/repo', runId: 'run-alpha' }, apiRequest);

    expect(apiRequest).toHaveBeenNthCalledWith(1, 'GET', '/api/research-memory/runs?root=%2Frepo&projectId=proj-alpha');
    expect(apiRequest).toHaveBeenNthCalledWith(2, 'GET', '/api/research-memory/artifacts?root=%2Frepo&runId=run-alpha');
  });

  it('dispatches research loops through WorkerManager-backed bridge endpoint', async () => {
    const apiRequest = vi.fn(async () => ({
      status: 202,
      data: {
        runId: 'run-alpha',
        status: 'dispatched',
        preflight: {
          stages: [{ phase: 'context_pack', status: 'planned' }],
          outputContract: ['contract_version', 'hypotheses', 'negative_results', 'memory_event_candidates'],
        },
      },
    }));

    const result = await callResearchMemoryMcpTool(
      'research_loop_dispatch',
      {
        root: '/repo',
        projectId: 'proj-alpha',
        runId: 'run-alpha',
        task: 'Run memory experiment',
        domain: 'metabot',
        botName: 'admin',
        pmChatId: 'oc_test',
        reviewRequired: true,
      },
      apiRequest,
    );
    expect(result.content[0]!.text).toContain('context_pack');
    expect(result.content[0]!.text).toContain('memory_event_candidates');

    expect(apiRequest).toHaveBeenCalledWith('POST', '/api/research-memory/research-loop/dispatch', {
      root: '/repo',
      projectId: 'proj-alpha',
      runId: 'run-alpha',
      task: 'Run memory experiment',
      domain: 'metabot',
      botName: 'admin',
      pmChatId: 'oc_test',
      reviewRequired: true,
    });
  });

  it('approves promotions by request event id', async () => {
    const apiRequest = vi.fn(async () => ({ status: 201, data: { promotedEvent: { id: 'mem_evt_promoted' } } }));

    await callResearchMemoryMcpTool(
      'memory_promotion_approve',
      { root: '/repo', requestEventId: 'mem_evt_request', visibility: 'domain', domain: 'metabot' },
      apiRequest,
    );

    expect(apiRequest).toHaveBeenCalledWith('POST', '/api/research-memory/promotions/approve', {
      root: '/repo',
      requestEventId: 'mem_evt_request',
      actor: { kind: 'user', id: 'mcp-user' },
      scope: { domain: 'metabot', visibility: 'domain' },
    });
  });
});
