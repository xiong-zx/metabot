import { generateKeyPairSync } from 'node:crypto';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';

import { ArcArtifactStore } from '../src/artifact-store.js';
import { ArcCoordinator } from '../src/coordinator.js';
import { ArcDaemon } from '../src/daemon.js';
import { ArcCapabilityVerifier, issueArcCapability } from '../src/local-auth.js';
import { ArcRunStore } from '../src/run-store.js';
import { ArcProjectScope } from '../src/scope-policy.js';
import type { ArcTrustedPrincipal } from '../src/server.js';
import { FakeArcRunner } from './fake-runner.js';
import { projectDirectory, removeDirectory, temporaryDirectory } from './helpers.js';

const CAPABILITY_KEYS = generateKeyPairSync('ed25519');
const PM: ArcTrustedPrincipal = { role: 'pm', botName: 'research-pm', chatId: 'chat-a' };
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('ARC daemon connection authority', () => {
  it('fails closed without a capability and binds originator outside tool input', async () => {
    const kit = await makeDaemon();
    const initialize = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    };
    expect((await fetch(kit.daemon.url, { method: 'POST', body: JSON.stringify(initialize) })).status).toBe(401);

    const capability = kit.issue(PM);
    const connected = await connect(kit.daemon.url, capability);
    cleanups.push(() => connected.client.close());
    const result = await connected.client.callTool({
      name: 'arc_run_start',
      arguments: {
        project_id: 'project-1',
        project_root: kit.projectRoot,
        objective: 'Record authenticated origin without accepting identity arguments.',
        idempotency_key: 'origin-1',
        run_id: 'run-origin-1',
      },
    });
    expect(result.structuredContent).toMatchObject({
      run: { originator: { bot_name: 'research-pm', chat_id: 'chat-a' } },
    });
    expect(kit.store.getAuthorizingCapability('run-origin-1')).toBe(capability);
    expect(JSON.stringify(result.structuredContent)).not.toContain(capability);
    expect(JSON.stringify((await connected.client.listTools()).tools)).not.toMatch(
      /actor_role|caller_context|botName|chatId|pmChatId/,
    );
  });

  it('allows a low-privilege principal to read but not mutate and prevents session rebinding', async () => {
    const kit = await makeDaemon();
    const pm = await connect(kit.daemon.url, kit.issue(PM));
    cleanups.push(() => pm.client.close());
    await pm.client.callTool({
      name: 'arc_run_start',
      arguments: {
        project_id: 'project-1',
        project_root: kit.projectRoot,
        objective: 'Seed a readable run.',
        idempotency_key: 'seed-1',
        run_id: 'run-seed-1',
      },
    });

    const agent: ArcTrustedPrincipal = { role: 'agent', botName: 'agent-a', chatId: 'chat-a' };
    const connected = await connect(kit.daemon.url, kit.issue(agent));
    cleanups.push(() => connected.client.close());
    expect((await connected.client.callTool({ name: 'arc_run_list', arguments: {} })).isError).not.toBe(true);
    const denied = await connected.client.callTool({
      name: 'arc_run_start',
      arguments: {
        project_id: 'project-1',
        project_root: kit.projectRoot,
        objective: 'Must not start.',
        idempotency_key: 'denied',
      },
    });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied.content)).toContain('scope_denied');

    const rebound = await fetch(kit.daemon.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${kit.issue(PM)}`,
        'content-type': 'application/json',
        'mcp-session-id': connected.transport.sessionId as string,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    expect(rebound.status).toBe(403);
  });
});

async function makeDaemon() {
  const temporary = temporaryDirectory('arc-daemon-');
  const projectRoot = projectDirectory(temporary);
  const artifacts = new ArcArtifactStore();
  const store = new ArcRunStore(path.join(temporary, 'state'));
  const runner = new FakeArcRunner();
  const scope = new ArcProjectScope(artifacts, { allowedProjectRoots: [projectRoot], fixedProjectId: 'project-1' });
  const coordinator = new ArcCoordinator(store, artifacts, runner, { scope });
  const verifier = new ArcCapabilityVerifier([CAPABILITY_KEYS.publicKey]);
  const daemon = new ArcDaemon(coordinator, {
    endpoint: 'http://127.0.0.1:0/mcp',
    capabilityVerifier: verifier,
  });
  await daemon.start();
  cleanups.push(async () => {
    await daemon.close();
    coordinator.dispose();
    store.close();
    removeDirectory(temporary);
  });
  return {
    temporary,
    projectRoot,
    store,
    runner,
    coordinator,
    issue: (principal: ArcTrustedPrincipal) =>
      issueArcCapability(CAPABILITY_KEYS.privateKey, {
        v: 1,
        purpose: 'arc',
        role: principal.role,
        botName: principal.botName,
        chatId: principal.chatId,
        exp: Date.now() + 60_000,
      }),
    daemon,
  };
}

async function connect(url: URL, capability: string) {
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: `Bearer ${capability}` } },
  });
  const client = new Client({ name: 'arc-daemon-test', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}
