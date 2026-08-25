import path from 'node:path';
import { chmodSync, writeFileSync } from 'node:fs';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';

import { createMetaClawRuntime } from '../src/runtime.js';
import { createMetaClawMcpServer } from '../src/server.js';
import { METACLAW_TOOL_NAMES } from '../src/tools.js';
import {
  ALL_GATES_SATISFIED,
  cleanupFixtures,
  createFixture,
  fakeService,
  jsonResponse,
  writeSkill,
  type FixtureOptions,
} from './helpers.js';

afterEach(cleanupFixtures);

/**
 * Against the real server, over a real MCP transport.
 *
 * The previous schema suite asserted against the exported schema constants,
 * which were strict and stayed strict no matter what the server did with them.
 * A server that registered raw shapes and dropped the strictness agreed with
 * every one of those assertions. So everything here goes through
 * `tools/list` and `tools/call` on a connected client: what the client is
 * offered, and what the server actually accepts.
 */
async function connect(options: FixtureOptions = {}) {
  const fixture = createFixture(options);
  const service = fakeService(() =>
    jsonResponse({
      status: 'ok',
      release_id: '0.4.1+mcpsec.1-fixture',
      choices: [{ message: { role: 'assistant', content: 'fixture answer' } }],
    }),
  );
  const runtime = createMetaClawRuntime({ env: fixture.env, fetchImpl: service.fetchImpl });
  const server = createMetaClawMcpServer(runtime);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server, fixture, requests: service.requests };
}

describe('advertised tool manifest', () => {
  it('offers exactly the five tools and nothing that mutates the service', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...METACLAW_TOOL_NAMES].sort());
    for (const forbidden of ['start', 'stop', 'restart', 'setup', 'train', 'memory', 'config', 'auth', 'evolve']) {
      expect(tools.some((tool) => tool.name.includes(forbidden)), forbidden).toBe(false);
    }
  });

  it('advertises additionalProperties:false on every tool the server registered', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.inputSchema, tool.name).toMatchObject({ type: 'object', additionalProperties: false });
    }
  });

  it('offers no model, provider, base URL, stream, or session field on infer', async () => {
    const { client } = await connect();
    const infer = (await client.listTools()).tools.find((tool) => tool.name === 'metaclaw_infer');
    expect(Object.keys(infer!.inputSchema.properties ?? {}).sort()).toEqual([
      'controls',
      'deadlineMs',
      'maxOutputTokens',
      'messages',
      'temperature',
    ]);
  });
});

describe('tools/call argument validation', () => {
  it('rejects an unknown argument on infer instead of ignoring it', async () => {
    const { client, requests } = await connect({ gates: ALL_GATES_SATISFIED });
    const result = await client.callTool({
      name: 'metaclaw_infer',
      arguments: { messages: [{ role: 'user', content: 'hi' }], model: 'expensive-model' },
    });
    expect(result).toHaveProperty('isError', true);
    expect(JSON.stringify(result)).toMatch(/Invalid arguments/);
    // Refused before dispatch: an argument the server ignores is an argument
    // the caller believes it set, and a provider call it may still be billed for.
    expect(requests).toHaveLength(0);
  });

  it('rejects an unknown argument on each no-argument tool', async () => {
    const { client } = await connect();
    for (const name of ['metaclaw_health', 'metaclaw_status', 'metaclaw_skills_list']) {
      const result = await client.callTool({ name, arguments: { force: true } });
      expect(result, name).toHaveProperty('isError', true);
      expect(JSON.stringify(result), name).toMatch(/Invalid arguments/);
    }
  });

  it('rejects an extra argument alongside a valid one on skill_get', async () => {
    const { client } = await connect();
    const result = await client.callTool({
      name: 'metaclaw_skill_get',
      arguments: { name: 'research', path: '/etc/passwd' },
    });
    expect(result).toHaveProperty('isError', true);
    expect(JSON.stringify(result)).toMatch(/Invalid arguments/);
  });

  it('rejects a malformed message role rather than forwarding it', async () => {
    const { client, requests } = await connect({ gates: ALL_GATES_SATISFIED });
    const result = await client.callTool({
      name: 'metaclaw_infer',
      arguments: { messages: [{ role: 'tool', content: 'hi' }] },
    });
    expect(result).toHaveProperty('isError', true);
    expect(requests).toHaveLength(0);
  });

  it('accepts the declared arguments and answers', async () => {
    const { client, fixture } = await connect();
    writeSkill(fixture.skillsRoot, 'research', '# Research\n');
    const result = await client.callTool({ name: 'metaclaw_skill_get', arguments: { name: 'research' } });
    expect((result as { structuredContent: { content: string } }).structuredContent.content).toBe('# Research\n');
  });
});

describe('spawned stdio server', () => {
  it('serves the strict five-tool contract over an actual child stdio transport', async () => {
    const fixture = createFixture();
    const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'packages/metaclaw-mcp/src/bin.ts'],
      cwd: repositoryRoot,
      env: { ...getDefaultEnvironment(), ...(fixture.env as Record<string, string>) },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'metaclaw-stdio-test', version: '0.1.0' });
    try {
      await client.connect(transport);
      const tools = (await client.listTools()).tools;
      expect(tools.map((tool) => tool.name).sort()).toEqual([...METACLAW_TOOL_NAMES].sort());
      expect(tools.every((tool) => tool.inputSchema.additionalProperties === false)).toBe(true);

      const refused = await client.callTool({ name: 'metaclaw_health', arguments: { force: true } });
      expect(refused).toHaveProperty('isError', true);
      const status = await client.callTool({ name: 'metaclaw_status', arguments: {} });
      expect(status).not.toHaveProperty('isError', true);
      expect(status.structuredContent).toMatchObject({ tools: [...METACLAW_TOOL_NAMES] });
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it('redacts a startup service-bearer failure from spawned-process stderr', async () => {
    const fixture = createFixture();
    const marker = 'startup-secret-marker-123456789';
    writeFileSync(fixture.bearerPath, marker, { mode: 0o644 });
    chmodSync(fixture.bearerPath, 0o644);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'packages/metaclaw-mcp/src/bin.ts'],
      cwd: path.resolve(import.meta.dirname, '../../..'),
      env: { ...getDefaultEnvironment(), ...(fixture.env as Record<string, string>) },
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    const client = new Client({ name: 'metaclaw-stdio-bad-startup', version: '0.1.0' });
    try {
      await expect(client.connect(transport)).rejects.toThrow();
    } finally {
      await transport.close().catch(() => undefined);
    }
    expect(stderr).toContain('profile_invalid');
    expect(stderr).not.toContain(marker);
    expect(stderr).not.toContain(fixture.bearerPath);
  });
});
