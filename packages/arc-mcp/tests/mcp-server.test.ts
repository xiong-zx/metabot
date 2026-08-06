import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';

import { projectDirectory, removeDirectory, temporaryDirectory } from './helpers.js';

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
  it('lists and calls all six lifecycle tools over a spawned stdio transport', async () => {
    const temporary = temporaryDirectory('arc-mcp-stdio-');
    cleanup.push(temporary);
    const projectRoot = projectDirectory(temporary);
    const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const repositoryRoot = path.resolve(packageRoot, '../..');
    const runnerModule = path.join(packageRoot, 'tests', 'fixtures', 'stdio-runner.mjs');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'packages/arc-mcp/src/bin.ts'],
      cwd: repositoryRoot,
      env: {
        ...getDefaultEnvironment(),
        METABOT_ARC_DATA_DIR: path.join(temporary, 'state'),
        METABOT_ARC_PROJECT_ID: 'stdio-project',
        METABOT_ARC_PROJECT_ROOTS: JSON.stringify([projectRoot]),
        METABOT_ARC_RUNNER_MODULE: runnerModule,
      },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'arc-mcp-test', version: '0.1.0' });

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        'arc_run_cancel',
        'arc_run_get',
        'arc_run_list',
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
    }
  });
});
