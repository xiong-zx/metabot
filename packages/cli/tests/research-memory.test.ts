import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIG_ENV = { ...process.env };
let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-research-memory-cli-'));
  process.env.API_PORT = '9100';
  process.env.API_SECRET = 'test-secret';
  delete process.env.METABOT_URL;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...ORIG_ENV };
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function importFresh(): Promise<typeof import('../src/research-memory.js')> {
  vi.resetModules();
  return await import('../src/research-memory.js');
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function calls(fetchMock: typeof fetch): [string, RequestInit][] {
  return (fetchMock as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
}

describe('metabot research-memory CLI', () => {
  it('logs events through the controlled bridge endpoint', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ event: { id: 'mem_evt_1' } }, 201)) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const mod = await importFresh();
    await mod.run([
      'events',
      'log',
      '--root',
      tempDir,
      '--type',
      'decision',
      '--summary',
      'Use policy-safe memory API',
      '--project',
      'proj-alpha',
      '--domain',
      'metabot',
    ]);

    const [url, init] = calls(fetchMock)[0]!;
    expect(url).toBe('http://localhost:9100/api/research-memory/events');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-secret');
    expect(JSON.parse(String(init.body))).toEqual({
      root: tempDir,
      event: {
        type: 'decision',
        summary: 'Use policy-safe memory API',
        actor: { kind: 'agent', id: 'cli' },
        scope: { project_id: 'proj-alpha', domain: 'metabot', visibility: 'project' },
      },
    });
  });

  it('maps fact event shorthand to finding', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ event: { id: 'mem_evt_fact' } }, 201)) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const mod = await importFresh();
    await mod.run([
      'events',
      'log',
      '--root',
      tempDir,
      '--type',
      'fact',
      '--summary',
      'Smoke fact',
      '--project',
      'proj-alpha',
    ]);

    expect(JSON.parse(String(calls(fetchMock)[0]![1].body))).toMatchObject({
      event: {
        type: 'finding',
        summary: 'Smoke fact',
      },
    });
  });

  it('builds search query params for project-scoped retrieval', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const mod = await importFresh();
    await mod.run(['search', 'negative', 'results', '--root', tempDir, '--project', 'proj-alpha', '--limit', '5']);

    const [url, init] = calls(fetchMock)[0]!;
    expect(url).toBe(
      `http://localhost:9100/api/research-memory/search?root=${encodeURIComponent(tempDir)}&q=negative+results&projectId=proj-alpha&limit=5`,
    );
    expect(init.method).toBe('GET');
  });

  it('lists runs and artifacts through lifecycle endpoints', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const mod = await importFresh();
    await mod.run(['runs', '--root', tempDir, '--project', 'proj-alpha']);
    await mod.run(['artifacts', '--root', tempDir, '--run', 'run-alpha']);

    expect(calls(fetchMock)[0]![0]).toBe(
      `http://localhost:9100/api/research-memory/runs?root=${encodeURIComponent(tempDir)}&projectId=proj-alpha`,
    );
    expect(calls(fetchMock)[1]![0]).toBe(
      `http://localhost:9100/api/research-memory/artifacts?root=${encodeURIComponent(tempDir)}&runId=run-alpha`,
    );
  });

  it('dispatches a research loop through the bridge endpoint', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ runId: 'run-alpha', status: 'dispatched' }, 202),
    ) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const mod = await importFresh();
    await mod.run([
      'dispatch',
      'Run',
      'memory',
      'experiment',
      '--root',
      tempDir,
      '--project',
      'proj-alpha',
      '--run',
      'run-alpha',
      '--bot',
      'admin',
      '--chat',
      'oc_test',
      '--domain',
      'metabot',
      '--review',
    ]);

    expect(calls(fetchMock)[0]![0]).toBe('http://localhost:9100/api/research-memory/research-loop/dispatch');
    expect(JSON.parse(String(calls(fetchMock)[0]![1].body))).toMatchObject({
      root: tempDir,
      projectId: 'proj-alpha',
      runId: 'run-alpha',
      task: 'Run memory experiment',
      botName: 'admin',
      pmChatId: 'oc_test',
      domain: 'metabot',
      reviewRequired: true,
    });
  });

  it('ingests an AutoResearchClaw artifact with review staging', async () => {
    const artifact = path.join(tempDir, 'autoresearchclaw-output.json');
    fs.writeFileSync(artifact, JSON.stringify({ contract_version: 'autoresearchclaw.output.v1' }));
    const fetchMock = vi.fn(async () => jsonResponse({ events: [] }, 201)) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const mod = await importFresh();
    await mod.run(['ingest', artifact, '--root', tempDir, '--project', 'proj-alpha', '--run', 'run-alpha', '--review']);

    const body = JSON.parse(String(calls(fetchMock)[0]![1].body));
    expect(calls(fetchMock)[0]![0]).toBe('http://localhost:9100/api/research-memory/autoresearchclaw/ingest');
    expect(body).toMatchObject({
      root: tempDir,
      output: { contract_version: 'autoresearchclaw.output.v1' },
      actor: { kind: 'agent', id: 'autoresearchclaw' },
      scope: { project_id: 'proj-alpha', visibility: 'project', run_id: 'run-alpha' },
      reviewRequired: true,
    });
  });

  it('approves promotions by request id instead of target id', async () => {
    process.env.METABOT_MEMORY_ADMIN_TOKEN = 'admin-secret';
    const fetchMock = vi.fn(async () =>
      jsonResponse({ promotedEvent: { id: 'mem_evt_promoted' } }, 201),
    ) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const mod = await importFresh();
    await mod.run([
      'promote',
      'approve',
      'mem_evt_request',
      '--root',
      tempDir,
      '--visibility',
      'domain',
      '--domain',
      'metabot',
    ]);

    expect(calls(fetchMock)[0]![0]).toBe('http://localhost:9100/api/research-memory/promotions/approve');
    expect((calls(fetchMock)[0]![1].headers as Record<string, string>)['X-Metabot-Memory-Admin-Token']).toBe(
      'admin-secret',
    );
    expect(JSON.parse(String(calls(fetchMock)[0]![1].body))).toEqual({
      root: tempDir,
      requestEventId: 'mem_evt_request',
      actor: { kind: 'user', id: 'cli-user' },
      scope: { domain: 'metabot', visibility: 'domain' },
    });
  });
});
