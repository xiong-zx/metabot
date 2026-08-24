import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';

import { projectDirectory, removeDirectory, temporaryDirectory } from './helpers.js';
import { ArcProductService } from '../src/product-service.js';
import { createArcRuntime } from '../src/runtime.js';

const cleanup: string[] = [];

afterEach(() => {
  for (const directory of cleanup.splice(0)) removeDirectory(directory);
});

function runFrom(result: { structuredContent?: Record<string, unknown> }): Record<string, unknown> {
  const run = result.structuredContent?.run;
  expect(run).toBeTypeOf('object');
  return run as Record<string, unknown>;
}

describe('ARC stdio MCP server', () => {
  it('lists lifecycle, official HITL, and provenance tools over a spawned stdio transport', async () => {
    const temporary = temporaryDirectory('arc-mcp-stdio-');
    cleanup.push(temporary);
    const projectRoot = projectDirectory(temporary);
    const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const repositoryRoot = path.resolve(packageRoot, '../..');
    const runnerModule = path.join(packageRoot, 'tests', 'fixtures', 'stdio-runner.mjs');
    const dataDir = path.join(temporary, 'state');
    const runtime = await createArcRuntime({
      env: {
        ARC_MCP_DATA_DIR: dataDir,
        ARC_MCP_PROJECT_ID: 'stdio-project',
        ARC_MCP_PROJECT_ROOTS: JSON.stringify([projectRoot]),
        ARC_MCP_RUNNER_MODULE: runnerModule,
      },
    });
    const bearer = 'arc-product-test-bearer-0000000000000001';
    const service = new ArcProductService(runtime.coordinator, {
      endpoint: 'http://127.0.0.1:0/mcp',
      bearer,
    });
    await service.start();
    const bearerFile = path.join(temporary, 'bearer');
    const configFile = path.join(temporary, 'config.json');
    writeFileSync(bearerFile, `${bearer}\n`, { mode: 0o600 });
    writeFileSync(configFile, JSON.stringify({
      version: 1,
      service_url: service.url.toString(),
      bearer_file: bearerFile,
      data_dir: dataDir,
      allowed_project_roots: [projectRoot],
      fixed_project_id: 'stdio-project',
      runner_module: runnerModule,
    }), { mode: 0o600 });
    const createTransport = (): StdioClientTransport => new StdioClientTransport({
        command: process.execPath,
        args: ['--import', 'tsx', 'packages/arc-mcp/src/bin.ts'],
        cwd: repositoryRoot,
        env: {
          ...getDefaultEnvironment(),
          ARC_MCP_CONFIG_FILE: configFile,
        },
        stderr: 'pipe',
      });
    const transport = createTransport();
    const client = new Client({ name: 'arc-mcp-test', version: '0.1.0' });

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        'arc_hitl_submit',
        'arc_run_cancel',
        'arc_run_get',
        'arc_run_list',
        'arc_run_manifest',
        'arc_run_pause',
        'arc_run_resume',
        'arc_run_start',
      ]);

      const denied = await client.callTool({
        name: 'arc_run_start',
        arguments: {
          project_id: 'other-project',
          project_root: projectRoot,
          objective: 'Must fail through the MCP error result.',
          idempotency_key: 'stdio-denied',
        },
      });
      expect(denied.isError).toBe(true);
      expect(denied.content).toEqual([
        expect.objectContaining({ type: 'text', text: expect.stringContaining('scope_denied') }),
      ]);

      const started = await client.callTool({
        name: 'arc_run_start',
        arguments: {
          project_id: 'stdio-project',
          project_root: projectRoot,
          objective: 'Exercise the real MCP stdio transport.',
          idempotency_key: 'stdio-start-1',
          run_id: 'stdio-run-1',
        },
      });
      expect(runFrom(started).status).toBe('running');

      const fetched = await client.callTool({
        name: 'arc_run_get',
        arguments: { run_id: 'stdio-run-1' },
      });
      expect(runFrom(fetched).run_id).toBe('stdio-run-1');

      const paused = await client.callTool({
        name: 'arc_run_pause',
        arguments: { run_id: 'stdio-run-1' },
      });
      expect(runFrom(paused).status).toBe('paused');

      const observer = new Client({ name: 'arc-mcp-observer', version: '0.1.0' });
      try {
        await observer.connect(createTransport());
        const observed = await observer.callTool({ name: 'arc_run_get', arguments: { run_id: 'stdio-run-1' } });
        expect(runFrom(observed)).toMatchObject({ run_id: 'stdio-run-1', status: 'paused' });
      } finally {
        await observer.close();
      }

      const resumed = await client.callTool({
        name: 'arc_run_resume',
        arguments: { run_id: 'stdio-run-1' },
      });
      expect(runFrom(resumed)).toMatchObject({ status: 'running', recovery_generation: 1 });

      const deadline = Date.now() + 3_000;
      let completed: Record<string, unknown> | undefined;
      while (Date.now() < deadline) {
        const result = await client.callTool({
          name: 'arc_run_get',
          arguments: { run_id: 'stdio-run-1' },
        });
        completed = runFrom(result);
        if (completed.status === 'completed') break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(completed?.status).toBe('completed');

      const listed = await client.callTool({
        name: 'arc_run_list',
        arguments: { project_id: 'stdio-project', limit: 10 },
      });
      expect(listed.structuredContent?.runs).toEqual([
        expect.objectContaining({ run_id: 'stdio-run-1', status: 'completed' }),
      ]);

      await client.callTool({
        name: 'arc_run_start',
        arguments: {
          project_id: 'stdio-project',
          project_root: projectRoot,
          objective: 'Exercise cancellation.',
          idempotency_key: 'stdio-start-2',
          run_id: 'stdio-run-2',
        },
      });
      const cancelled = await client.callTool({
        name: 'arc_run_cancel',
        arguments: { run_id: 'stdio-run-2' },
      });
      expect(runFrom(cancelled).status).toBe('cancelled');
    } finally {
      await client.close();
      await service.close();
      runtime.coordinator.dispose();
      runtime.store.close();
    }
  });
});
