import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildCodexMcpConfigArgs,
  externalMcpEnvironment,
  leaseClaudeMcpConfig,
  resolveExternalMcpServers,
  toClaudeMcpServers,
  type ExternalMcpServerDescriptor,
} from '../src/mcp/external-server.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function install(name: string): { root: string; executable: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'metabot-external-mcp-test-'));
  roots.push(root);
  const executable = path.join(root, name);
  writeFileSync(executable, '#!/bin/sh\n', { encoding: 'utf8', mode: 0o755 });
  chmodSync(executable, 0o755);
  return { root, executable: realpathSync(executable) };
}

function descriptor(patch: Partial<ExternalMcpServerDescriptor> = {}): ExternalMcpServerDescriptor {
  return {
    name: 'example-server',
    enabled: true,
    command: 'example-mcp',
    args: ['--stdio'],
    approvalMode: 'writes',
    ...patch,
  };
}

describe('external MCP descriptor resolution', () => {
  it('discovers an installed executable and passes product configuration without MetaBot identity', () => {
    const { root, executable } = install('example-mcp');
    const result = resolveExternalMcpServers(
      [descriptor({ env: { EXAMPLE_MODE: 'read-only' }, envFrom: { EXAMPLE_BEARER: 'PRODUCT_BEARER' } })],
      { PATH: root, PRODUCT_BEARER: 'secret-value' },
    );

    expect(result.failures).toEqual([]);
    expect(result.servers).toEqual([
      expect.objectContaining({
        name: 'example-server',
        command: executable,
        args: ['--stdio'],
        env: { EXAMPLE_MODE: 'read-only', EXAMPLE_BEARER: 'secret-value' },
        approvalMode: 'writes',
      }),
    ]);
    expect(JSON.stringify(result.servers)).not.toMatch(/botName|chatId|capability|audience|role/);
  });

  it('requires explicit per-bot enablement', () => {
    const { root } = install('example-mcp');
    const result = resolveExternalMcpServers(
      [descriptor({ enabled: false }), descriptor({ name: 'also-disabled', enabled: undefined as unknown as boolean })],
      { PATH: root },
    );
    expect(result).toEqual({ servers: [], failures: [] });
  });

  it('fails closed when the per-bot descriptor collection is malformed', () => {
    expect(resolveExternalMcpServers(
      { invalid: true } as unknown as ExternalMcpServerDescriptor[],
      {},
    )).toEqual({
      servers: [],
      failures: [{ server: '(configuration)', reason: 'mcpServers must be an array' }],
    });
  });

  it('omits only the missing or conflicting product', () => {
    const { root } = install('healthy-mcp');
    const result = resolveExternalMcpServers(
      [
        descriptor({ name: 'missing', command: 'missing-mcp', env: { SHARED_MODE: 'missing' } }),
        descriptor({ name: 'healthy', command: 'healthy-mcp', env: { SHARED_MODE: 'healthy' } }),
        descriptor({ name: 'conflict', command: 'healthy-mcp', env: { SHARED_MODE: 'different' } }),
      ],
      { PATH: root },
    );

    expect(result.servers.map((server) => server.name)).toEqual(['healthy']);
    expect(result.failures).toEqual([
      expect.objectContaining({ server: 'missing', reason: expect.stringContaining('not found') }),
      expect.objectContaining({ server: 'conflict', reason: expect.stringContaining('conflicts') }),
    ]);
  });
});

describe('engine-native MCP configuration', () => {
  it('uses Codex native approvals and keeps product values out of argv', () => {
    const { root } = install('example-mcp');
    const [server] = resolveExternalMcpServers(
      [descriptor({
        envFrom: { EXAMPLE_BEARER: 'PRODUCT_BEARER' },
        enabledTools: ['read', 'write'],
        disabledTools: ['delete'],
        toolApprovals: { read: 'approve', write: 'prompt' },
        startupTimeoutSec: 12,
        toolTimeoutSec: 30,
      })],
      { PATH: root, PRODUCT_BEARER: 'secret-value' },
    ).servers;

    const args = buildCodexMcpConfigArgs([server]);
    expect(args).toContain('mcp_servers.example-server.default_tools_approval_mode="writes"');
    expect(args).toContain('mcp_servers.example-server.env_vars=["EXAMPLE_BEARER"]');
    expect(args).toContain('mcp_servers.example-server.tools.read.approval_mode="approve"');
    expect(args).toContain('mcp_servers.example-server.tools.write.approval_mode="prompt"');
    expect(args).toContain('mcp_servers.example-server.enabled_tools=["read","write"]');
    expect(args).toContain('mcp_servers.example-server.disabled_tools=["delete"]');
    expect(args.join(' ')).not.toContain('secret-value');
    expect(externalMcpEnvironment([server])).toEqual({ EXAMPLE_BEARER: 'secret-value' });
  });

  it('gives Claude the same command, args, environment, and server name', () => {
    const { root, executable } = install('example-mcp');
    const [server] = resolveExternalMcpServers(
      [descriptor({ env: { EXAMPLE_MODE: 'read-only' } })],
      { PATH: root },
    ).servers;
    expect(toClaudeMcpServers([server])).toEqual({
      'example-server': {
        command: executable,
        args: ['--stdio'],
        env: { EXAMPLE_MODE: 'read-only' },
      },
    });
  });

  it('leases a private Claude CLI config and removes it idempotently', () => {
    const { root } = install('example-mcp');
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'metabot-external-mcp-lease-test-'));
    roots.push(tempRoot);
    const [server] = resolveExternalMcpServers(
      [descriptor({ envFrom: { EXAMPLE_BEARER: 'PRODUCT_BEARER' } })],
      { PATH: root, PRODUCT_BEARER: 'secret-value' },
    ).servers;

    const lease = leaseClaudeMcpConfig([server], tempRoot)!;
    const text = readFileSync(lease.path, 'utf8');
    expect(lstatSync(path.dirname(lease.path)).mode & 0o777).toBe(0o700);
    expect(lstatSync(lease.path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(text).mcpServers['example-server']).toMatchObject({
      command: server.command,
      args: ['--stdio'],
      env: { EXAMPLE_BEARER: 'secret-value' },
    });

    lease.cleanup();
    lease.cleanup();
    expect(existsSync(lease.path)).toBe(false);
  });
});
