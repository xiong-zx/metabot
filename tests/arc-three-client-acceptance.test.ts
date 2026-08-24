import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { materializeExecutionMcp } from '../src/engines/mcp-materialize.js';
import {
  ExecutionCapabilityService,
  provisionExecutionKeyPairs,
} from '../src/services/execution-capabilities.js';

/**
 * ARC-005 acceptance.
 *
 * MetaBot, Codex, and Claude each reach one real ARC daemon over the same
 * package-owned proxy, using capabilities this repository's issuer minted, and
 * observe the same durable run state. Everything runs against a disposable data
 * directory and a deterministic fake runner: no live database, no official
 * AutoResearchClaw launch, and no model call.
 */

const require = createRequire(import.meta.url);
const repositoryRoot = path.resolve(fileURLToPath(import.meta.url), '../..');
const tsxLoader = pathToFileURL(require.resolve('tsx')).href;

const BOT_NAME = 'pm';
const CHAT_ID = 'oc-acceptance';
const PORT = 9377;
const ENDPOINT = `http://127.0.0.1:${PORT}/mcp`;

let temporary = '';
let runtimeRoot = '';
let projectRoot = '';
let keysDir = '';
let daemon: ChildProcess | undefined;

const logger = { warn: vi.fn(), debug: vi.fn() };

/**
 * Real proxy executables in the runtime root, exactly as an install provides
 * them, because materialization refuses a command it cannot confine there.
 */
function installProxy(): void {
  const arcScript = path.join(runtimeRoot, 'packages', 'arc-mcp', 'dist', 'proxy-cli.js');
  const workerScript = path.join(runtimeRoot, 'packages', 'worker-runner-mcp', 'dist', 'proxy-cli.js');
  mkdirSync(path.dirname(arcScript), { recursive: true });
  mkdirSync(path.dirname(workerScript), { recursive: true });
  writeFileSync(
    arcScript,
    `#!/usr/bin/env node\nrequire('node:child_process').spawnSync(${JSON.stringify(process.execPath)}, ${JSON.stringify([
      '--import',
      tsxLoader,
      path.join(repositoryRoot, 'packages/arc-mcp/src/proxy-cli.ts'),
    ])}, { stdio: 'inherit', env: process.env });\n`,
    { encoding: 'utf8', mode: 0o755 },
  );
  writeFileSync(workerScript, '#!/bin/sh\nexit 1\n', {
    encoding: 'utf8',
    mode: 0o755,
  });
}

async function startDaemon(): Promise<void> {
  daemon = spawn(
    process.execPath,
    ['--import', tsxLoader, path.join(repositoryRoot, 'packages/arc-mcp/src/daemon-cli.ts')],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        METABOT_ARC_DATA_DIR: path.join(temporary, 'arc-data'),
        METABOT_ARC_PROJECT_ID: 'acceptance-project',
        METABOT_ARC_PROJECT_ROOTS: JSON.stringify([projectRoot]),
        METABOT_ARC_RUNNER_MODULE: path.join(repositoryRoot, 'packages/arc-mcp/tests/fixtures/stdio-runner.mjs'),
        METABOT_ARC_LISTEN: ENDPOINT,
        METABOT_ARC_CAPABILITY_PUBLIC_KEY_FILE: path.join(keysDir, 'arc-capability.pub'),
        METABOT_ARC_RELEASE_ROOT: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ARC daemon did not report a listener')), 30_000);
    daemon!.stderr!.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('listening on')) {
        clearTimeout(timer);
        resolve();
      }
    });
    daemon!.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`ARC daemon exited with ${code}`));
    });
  });
}

/**
 * One client's whole path: mint its capability, materialize its MCP entry the
 * way its engine would receive it, then speak MCP over the entry's own command.
 */
async function connectAs(engineName: 'codex' | 'claude'): Promise<{ client: Client; close: () => Promise<void> }> {
  const capability = new ExecutionCapabilityService(keysDir).issue({
    purpose: 'arc',
    role: 'pm',
    botName: BOT_NAME,
    chatId: CHAT_ID,
  });
  const materialized = materializeExecutionMcp({
    executionEnv: {
      METABOT_BOT_NAME: BOT_NAME,
      METABOT_CHAT_ID: CHAT_ID,
      METABOT_ARC_CAPABILITY: capability,
    },
    bridgeEnv: { METABOT_ARC_DAEMON_URL: ENDPOINT },
    runtimeRoot,
    engineName,
    botName: BOT_NAME,
    chatId: CHAT_ID,
    logger,
  })!;
  const entry =
    engineName === 'claude'
      ? (
          JSON.parse(readFileSync(materialized.claudeMcpConfigPath!, 'utf8')) as {
            mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
          }
        ).mcpServers['metabot-arc']
      : materialized.entries.find((candidate) => candidate.name === 'metabot-arc')!;

  const transport = new StdioClientTransport({
    command: entry.command,
    args: [...entry.args],
    env: { ...getDefaultEnvironment(), ...entry.env },
    stderr: 'pipe',
  });
  const client = new Client({ name: `arc-${engineName}`, version: '0.1.0' });
  await client.connect(transport);
  return {
    client,
    close: async () => {
      await client.close();
      materialized.cleanup();
    },
  };
}

beforeAll(async () => {
  temporary = realpathSync(mkdtempSync(path.join(tmpdir(), 'arc-three-client-')));
  runtimeRoot = path.join(temporary, 'runtime');
  projectRoot = path.join(temporary, 'project');
  keysDir = path.join(temporary, 'keys');
  mkdirSync(runtimeRoot, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  projectRoot = realpathSync(projectRoot);
  provisionExecutionKeyPairs(keysDir);
  installProxy();
  await startDaemon();
}, 60_000);

afterAll(async () => {
  if (daemon && daemon.exitCode === null) {
    daemon.kill('SIGTERM');
    await new Promise((resolve) => daemon!.once('exit', resolve));
  }
  if (temporary) rmSync(temporary, { recursive: true, force: true });
});

describe('ARC three-client acceptance', () => {
  it('shows one durable run to MetaBot, Codex, and Claude through one daemon', async () => {
    // The Bridge is the same path Codex takes: one materialized entry over the
    // package-owned proxy. Naming them separately keeps the assertion honest.
    const bridge = await connectAs('codex');
    const codex = await connectAs('codex');
    const claude = await connectAs('claude');
    try {
      const started = await bridge.client.callTool({
        name: 'arc_run_start',
        arguments: {
          project_id: 'acceptance-project',
          project_root: projectRoot,
          objective: 'Prove three clients observe one ARC run.',
          idempotency_key: 'three-client-acceptance',
        },
      });
      expect(started.isError).toBeFalsy();
      const runId = (started.structuredContent as { run: { run_id: string } }).run.run_id;
      expect(runId).toBeTruthy();

      for (const [name, connection] of [
        ['bridge', bridge],
        ['codex', codex],
        ['claude', claude],
      ] as const) {
        const observed = await connection.client.callTool({
          name: 'arc_run_get',
          arguments: { run_id: runId },
        });
        expect(observed.isError, `${name} could not read the run`).toBeFalsy();
        expect((observed.structuredContent as { run: { run_id: string } }).run.run_id).toBe(runId);
      }

      // Identical idempotency key from a different client returns the same run
      // rather than starting a second one against the same durable state.
      const repeated = await claude.client.callTool({
        name: 'arc_run_start',
        arguments: {
          project_id: 'acceptance-project',
          project_root: projectRoot,
          objective: 'Prove three clients observe one ARC run.',
          idempotency_key: 'three-client-acceptance',
        },
      });
      expect((repeated.structuredContent as { run: { run_id: string } }).run.run_id).toBe(runId);

      const listed = await codex.client.callTool({ name: 'arc_run_list', arguments: {} });
      expect(JSON.stringify(listed.structuredContent)).toContain(runId);
    } finally {
      await bridge.close();
      await codex.close();
      await claude.close();
    }
  }, 120_000);

  it('offers every client the same tool surface and no other product', async () => {
    const codex = await connectAs('codex');
    const claude = await connectAs('claude');
    try {
      const codexTools = (await codex.client.listTools()).tools.map((tool) => tool.name).sort();
      const claudeTools = (await claude.client.listTools()).tools.map((tool) => tool.name).sort();
      expect(codexTools).toEqual(claudeTools);
      expect(codexTools.every((name) => name.startsWith('arc_'))).toBe(true);
      expect(JSON.stringify(codexTools)).not.toMatch(/metaclaw|research.?stack|worker/i);
    } finally {
      await codex.close();
      await claude.close();
    }
  }, 60_000);

  it('keeps ARC fully usable while no MetaClaw server exists at all', async () => {
    // Nothing in this repository registers MetaClaw, and the ARC entry carries
    // no reference to one, so its absence cannot degrade ARC.
    const codex = await connectAs('codex');
    try {
      const listed = await codex.client.callTool({ name: 'arc_run_list', arguments: {} });
      expect(listed.isError).toBeFalsy();
      const materializedEntry = JSON.stringify(await codex.client.listTools());
      expect(materializedEntry).not.toMatch(/metaclaw/i);
    } finally {
      await codex.close();
    }
  }, 60_000);

  it('denies a project root outside the configured server scope', async () => {
    const codex = await connectAs('codex');
    try {
      const denied = await codex.client.callTool({
        name: 'arc_run_start',
        arguments: {
          project_id: 'acceptance-project',
          project_root: temporary,
          objective: 'Must not escape the configured project scope.',
          idempotency_key: 'outside-scope',
        },
      });
      expect(denied.isError).toBe(true);
      expect(JSON.stringify(denied.content)).toContain('scope_denied');
    } finally {
      await codex.close();
    }
  }, 60_000);

  it('refuses a capability this daemon did not trust, and one minted for another audience', async () => {
    // The trust boundary the daemon itself enforces is the signed capability:
    // which bot may hold one is decided earlier, when the Bridge materializes a
    // turn and refuses an execution identity that does not match it. Asserted
    // on the wire because an untrusted capability fails before MCP initialize
    // completes, which is the fail-closed behaviour we want.
    const foreignKeys = path.join(temporary, 'foreign-keys');
    provisionExecutionKeyPairs(foreignKeys);
    const foreignService = new ExecutionCapabilityService(foreignKeys);
    const trustedService = new ExecutionCapabilityService(keysDir);
    const principal = { role: 'pm', botName: BOT_NAME, chatId: CHAT_ID } as const;

    const cases: Array<[string, string]> = [
      ['untrusted issuer', foreignService.issue({ purpose: 'arc', ...principal })],
      // Signed by a key this daemon does not hold and carrying no arc audience.
      ['another audience', trustedService.issue({ purpose: 'worker', ...principal })],
    ];
    for (const [label, capability] of cases) {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${capability}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
      expect(response.status, `${label} was not refused`).toBe(401);
    }

    const accepted = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${trustedService.issue({ purpose: 'arc', ...principal })}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(accepted.status).not.toBe(401);
  }, 60_000);
});
