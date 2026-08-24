import { createPublicKey } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ArcCapabilityVerifier } from '@xvirobotics/arc-mcp';
import { buildExecutionMcpEntries } from '../src/engines/mcp-entries.js';
import { materializeExecutionMcp } from '../src/engines/mcp-materialize.js';
import {
  ExecutionCapabilityService,
  assertDistinctKeyMaterial,
  provisionExecutionKeyPairs,
  requiredCapabilityAudience,
} from '../src/services/execution-capabilities.js';
import {
  EXECUTION_MCP_SERVERS,
  assertDistinctMcpServers,
  isLoopbackProxy,
  type AnyMcpServerDescriptor,
} from '../src/services/mcp-registry.js';

/**
 * MCPINT-002/003/004/007.
 *
 * The generic abstraction is proven against fixture servers rather than against
 * ARC and MetaClaw, so a bad abstraction shows up here instead of after both
 * products depend on it. The one place a real product appears is the audience
 * interop check, which is exactly the claim that cannot be proven with a
 * fixture: that MetaBot's issuer and ARC's shipped verifier agree.
 */

const roots: string[] = [];
const logger = { warn: vi.fn(), debug: vi.fn() };

afterEach(() => {
  logger.warn.mockClear();
  logger.debug.mockClear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Two loopback fixtures plus one native server, none of them a real product. */
const ALPHA: AnyMcpServerDescriptor = {
  id: 'alpha',
  serverName: 'fixture-alpha',
  transport: 'loopback-proxy',
  audience: 'alpha',
  capabilityContract: 'v3-audience',
  standaloneEligible: false,
  optIn: 'workerTools',
  capabilityEnvVar: 'FIXTURE_ALPHA_CAPABILITY',
  capabilityFileEnvVar: 'FIXTURE_ALPHA_CAPABILITY_FILE',
  endpointEnvVar: 'FIXTURE_ALPHA_DAEMON_URL',
  proxyScript: ['packages', 'fixture-alpha', 'dist', 'proxy-cli.js'],
  proxyUrlEnvVar: 'FIXTURE_ALPHA_PROXY_URL',
};

const BETA: AnyMcpServerDescriptor = {
  id: 'beta',
  serverName: 'fixture-beta',
  transport: 'loopback-proxy',
  audience: 'beta',
  capabilityContract: 'v3-audience',
  standaloneEligible: false,
  optIn: 'arcTools',
  capabilityEnvVar: 'FIXTURE_BETA_CAPABILITY',
  capabilityFileEnvVar: 'FIXTURE_BETA_CAPABILITY_FILE',
  endpointEnvVar: 'FIXTURE_BETA_DAEMON_URL',
  proxyScript: ['packages', 'fixture-beta', 'dist', 'proxy-cli.js'],
  proxyUrlEnvVar: 'FIXTURE_BETA_PROXY_URL',
};

/** A future MCP-native server: spawned directly, authorized independently, no daemon hop. */
const NATIVE: AnyMcpServerDescriptor = {
  id: 'native',
  serverName: 'fixture-native',
  transport: 'native-stdio',
  audience: 'native',
  capabilityContract: 'v3-audience',
  standaloneEligible: true,
  optIn: 'workerTools',
  capabilityEnvVar: 'FIXTURE_NATIVE_CAPABILITY',
  capabilityFileEnvVar: 'FIXTURE_NATIVE_CAPABILITY_FILE',
  publicKeyEnvVar: 'FIXTURE_NATIVE_PUBLIC_KEY_FILE',
  previousPublicKeyEnvVar: 'FIXTURE_NATIVE_PREVIOUS_PUBLIC_KEY_FILE',
  binary: 'fixture-native-server',
  args: ['--stdio'],
  env: { FIXTURE_NATIVE_MODE: 'read-only' },
};

const SERVERS = [ALPHA, BETA, NATIVE];

function runtimeRoot(binaries = ['fixture-alpha-proxy', 'fixture-beta-proxy', 'fixture-native-server']): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'metabot-mcp-registry-')));
  roots.push(root);
  for (const binary of binaries) {
    const target = binary === 'fixture-native-server'
      ? path.join(root, 'node_modules', '.bin', binary)
      : binary === 'fixture-alpha-proxy'
        ? path.join(root, 'packages', 'fixture-alpha', 'dist', 'proxy-cli.js')
        : path.join(root, 'packages', 'fixture-beta', 'dist', 'proxy-cli.js');
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, '#!/bin/sh\n', { encoding: 'utf8', mode: 0o755 });
  }
  const keys = path.join(root, 'keys');
  mkdirSync(keys, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(keys, 'native-capability.pub'), 'fixture-public-key', { mode: 0o600 });
  return root;
}

function input(root: string, patch: Record<string, unknown> = {}) {
  return {
    executionEnv: {
      METABOT_BOT_NAME: 'pm',
      METABOT_CHAT_ID: 'oc-user',
      FIXTURE_ALPHA_CAPABILITY: 'ALPHA_TOKEN',
      FIXTURE_BETA_CAPABILITY: 'BETA_TOKEN',
      FIXTURE_NATIVE_CAPABILITY: 'NATIVE_TOKEN',
    },
    bridgeEnv: {
      METABOT_KEYS_DIR: path.join(root, 'keys'),
      FIXTURE_ALPHA_DAEMON_URL: 'http://127.0.0.1:9401/mcp',
      FIXTURE_BETA_DAEMON_URL: 'http://127.0.0.1:9402/mcp',
    },
    runtimeRoot: root,
    engineName: 'codex' as const,
    botName: 'pm',
    chatId: 'oc-user',
    logger,
    servers: SERVERS,
    ...patch,
  };
}

describe('data-driven MCP server registry', () => {
  it('materializes the real MetaClaw native stdio row with its own audience keys and no daemon hop', () => {
    const root = runtimeRoot();
    const binary = path.join(root, 'node_modules', '.bin', 'metabot-metaclaw-mcp');
    writeFileSync(binary, '#!/bin/sh\n', { encoding: 'utf8', mode: 0o755 });
    const keys = path.join(root, 'keys');
    writeFileSync(path.join(keys, 'metaclaw-capability.pub'), 'metaclaw-public-key', { mode: 0o600 });
    const metaclaw = EXECUTION_MCP_SERVERS.find((server) => server.id === 'metaclaw')!;
    const materialized = materializeExecutionMcp({
      executionEnv: {
        METABOT_BOT_NAME: 'pm',
        METABOT_CHAT_ID: 'oc-user',
        METABOT_METACLAW_CAPABILITY: 'METACLAW_TOKEN',
      },
      bridgeEnv: { METABOT_KEYS_DIR: keys },
      runtimeRoot: root,
      engineName: 'codex',
      botName: 'pm',
      chatId: 'oc-user',
      logger,
      servers: [metaclaw],
    })!;
    try {
      expect(materialized.entries).toHaveLength(1);
      expect(materialized.entries[0]).toMatchObject({
        name: 'metabot-metaclaw',
        command: binary,
        args: [],
        env: {
          METACLAW_MCP_CAPABILITY_PUBLIC_KEY_FILE: path.join(keys, 'metaclaw-capability.pub'),
        },
      });
      expect(readFileSync(materialized.entries[0].env.METACLAW_MCP_CAPABILITY_FILE, 'utf8')).toBe('METACLAW_TOKEN');
      expect(JSON.stringify(materialized.entries[0])).not.toContain('CALLBACK');
    } finally {
      materialized.cleanup();
    }
  });

  it('materializes every registered server for MetaBot, Codex, and Claude without editing core code', () => {
    const root = runtimeRoot();
    for (const engineName of ['codex', 'claude'] as const) {
      const materialized = materializeExecutionMcp(input(root, { engineName }))!;
      try {
        expect(materialized.entries.map((entry) => entry.name)).toEqual([
          'fixture-alpha',
          'fixture-beta',
          'fixture-native',
        ]);
      } finally {
        materialized.cleanup();
      }
    }
  });

  it('registers a native MCP server directly with its own capability and no daemon hop', () => {
    const root = runtimeRoot();
    const materialized = materializeExecutionMcp(input(root))!;
    try {
      const native = materialized.entries.find((entry) => entry.name === 'fixture-native')!;
      expect(native.command).toBe(path.join(root, 'node_modules', '.bin', 'fixture-native-server'));
      expect(native.args).toEqual(['--stdio']);
      expect(native.env).toMatchObject({ FIXTURE_NATIVE_MODE: 'read-only' });
      expect(native.env.FIXTURE_NATIVE_PUBLIC_KEY_FILE).toBe(path.join(root, 'keys', 'native-capability.pub'));
      expect(readFileSync(native.env.FIXTURE_NATIVE_CAPABILITY_FILE, 'utf8')).toBe('NATIVE_TOKEN');
      expect(JSON.stringify(native.args)).not.toMatch(/capability|token/i);
    } finally {
      materialized.cleanup();
    }
  });

  it('keeps every other server when one binary is missing', () => {
    const root = runtimeRoot(['fixture-beta-proxy', 'fixture-native-server']);
    const materialized = materializeExecutionMcp(input(root))!;
    try {
      expect(materialized.entries.map((entry) => entry.name)).toEqual(['fixture-beta', 'fixture-native']);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ server: 'fixture-alpha', reason: expect.stringMatching(/missing/i) }),
        expect.stringContaining('other external tools stay available'),
      );
    } finally {
      materialized.cleanup();
    }
  });

  it('keeps every other server when one endpoint is not loopback HTTP', () => {
    const root = runtimeRoot();
    const materialized = materializeExecutionMcp(
      input(root, {
        bridgeEnv: {
          FIXTURE_ALPHA_DAEMON_URL: 'https://alpha.example.com/mcp',
          FIXTURE_BETA_DAEMON_URL: 'http://127.0.0.1:9402/mcp',
        },
      }),
    )!;
    try {
      expect(materialized.entries.map((entry) => entry.name)).toEqual(['fixture-beta', 'fixture-native']);
    } finally {
      materialized.cleanup();
    }
  });

  it('keeps every other server when one capability lease fails', () => {
    const root = runtimeRoot();
    const first = materializeExecutionMcp(input(root, { nonce: () => 'collide', now: () => 1_000, servers: [ALPHA] }))!;
    // Alpha collides, while beta and native own different per-server paths and
    // remain available.
    const second = materializeExecutionMcp(input(root, { nonce: () => 'collide', now: () => 1_000 }))!;
    try {
      expect(second.entries.map((entry) => entry.name)).toEqual(['fixture-beta', 'fixture-native']);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ server: 'fixture-alpha', reason: expect.stringMatching(/already exists|EEXIST/i) }),
        expect.any(String),
      );
    } finally {
      first.cleanup();
      second.cleanup();
    }
  });

  it('omits a server the bot never received a capability for', () => {
    const root = runtimeRoot();
    const materialized = materializeExecutionMcp(
      input(root, {
        executionEnv: {
          METABOT_BOT_NAME: 'pm',
          METABOT_CHAT_ID: 'oc-user',
          FIXTURE_BETA_CAPABILITY: 'BETA_TOKEN',
          FIXTURE_NATIVE_CAPABILITY: 'NATIVE_TOKEN',
        },
      }),
    )!;
    try {
      expect(materialized.entries.map((entry) => entry.name)).toEqual(['fixture-beta', 'fixture-native']);
    } finally {
      materialized.cleanup();
    }
  });

  it('does not materialize a native stdio server without its explicit capability', () => {
    const root = runtimeRoot();
    const materialized = materializeExecutionMcp(
      input(root, {
        executionEnv: {
          METABOT_BOT_NAME: 'pm',
          METABOT_CHAT_ID: 'oc-user',
          FIXTURE_ALPHA_CAPABILITY: 'ALPHA_TOKEN',
          FIXTURE_BETA_CAPABILITY: 'BETA_TOKEN',
        },
      }),
    )!;
    try {
      expect(materialized.entries.map((entry) => entry.name)).toEqual(['fixture-alpha', 'fixture-beta']);
    } finally {
      materialized.cleanup();
    }
  });

  it('writes a Claude config assembled only from servers that survived', () => {
    const root = runtimeRoot(['fixture-beta-proxy', 'fixture-native-server']);
    const materialized = materializeExecutionMcp(input(root, { engineName: 'claude' }))!;
    try {
      const config = JSON.parse(readFileSync(materialized.claudeMcpConfigPath!, 'utf8')) as {
        mcpServers: Record<string, unknown>;
      };
      expect(Object.keys(config.mcpServers)).toEqual(['fixture-beta', 'fixture-native']);
    } finally {
      materialized.cleanup();
    }
  });

  it('builds nothing at all for a Team chat, whatever is registered', () => {
    const root = runtimeRoot();
    expect(
      buildExecutionMcpEntries({
        executionEnv: { METABOT_CHAT_ID: 'teaminst:project:agent', FIXTURE_ALPHA_CAPABILITY: 'ALPHA_TOKEN' },
        bridgeEnv: { FIXTURE_ALPHA_DAEMON_URL: 'http://127.0.0.1:9401/mcp' },
        runtimeRoot: root,
        capabilityFiles: { alpha: path.join(root, 'alpha.token') },
        servers: SERVERS,
      }),
    ).toEqual([]);
  });

  it('refuses a registry whose servers collide', () => {
    expect(() => assertDistinctMcpServers(SERVERS)).not.toThrow();
    expect(() => assertDistinctMcpServers([ALPHA, { ...BETA, audience: 'alpha' } as AnyMcpServerDescriptor])).toThrow(
      /reuses audience "alpha"/i,
    );
    expect(() =>
      assertDistinctMcpServers([ALPHA, { ...BETA, capabilityEnvVar: ALPHA.capabilityEnvVar } as AnyMcpServerDescriptor]),
    ).toThrow(/reuses capability variable/i);
    expect(() => assertDistinctMcpServers()).not.toThrow();
  });
});

describe('capability audience interop', () => {
  function keysDir(): string {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'metabot-mcp-keys-')));
    roots.push(dir);
    provisionExecutionKeyPairs(dir);
    return dir;
  }

  it("mints aud=arc and ARC's own shipped verifier accepts it", () => {
    const dir = keysDir();
    const token = new ExecutionCapabilityService(dir).issue(
      { purpose: 'arc', role: 'pm', botName: 'pm', chatId: 'oc-user' },
      1_000,
    );
    const verifier = new ArcCapabilityVerifier(
      [createPublicKey(readFileSync(path.join(dir, 'arc-capability.pub')))],
      () => 2_000,
    );
    expect(verifier.verify(token).claims).toMatchObject({ aud: 'arc', purpose: 'arc', role: 'pm' });
  });

  it('refuses an ARC token that carries no audience', () => {
    const dir = keysDir();
    const service = new ExecutionCapabilityService(dir);
    const token = service.issue({ purpose: 'arc', role: 'pm', botName: 'pm', chatId: 'oc-user' }, 1_000);
    const stripped = Buffer.from(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(
            JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8')) as Record<string, unknown>,
          ).filter(([key]) => key !== 'aud'),
        ),
      ),
    ).toString('base64url');
    expect(() =>
      service.verify(`${stripped}.${token.split('.')[1]}`, { purpose: 'arc', botName: 'pm', chatId: 'oc-user' }),
    ).toThrow();
  });

  it('keeps Worker Runner on its original claim set so its shipped verifier still accepts it', () => {
    const dir = keysDir();
    const token = new ExecutionCapabilityService(dir).issue(
      { purpose: 'worker', role: 'pm', botName: 'pm', chatId: 'oc-user' },
      1_000,
    );
    const claims = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8')) as Record<string, unknown>;
    expect(Object.keys(claims).sort()).toEqual(['botName', 'chatId', 'exp', 'purpose', 'role', 'v']);
    expect(requiredCapabilityAudience('worker')).toBeUndefined();
    expect(requiredCapabilityAudience('arc')).toBe('arc');
  });

  it("refuses a Worker token presented to ARC's verifier", () => {
    const dir = keysDir();
    const service = new ExecutionCapabilityService(dir);
    const worker = service.issue({ purpose: 'worker', role: 'pm', botName: 'pm', chatId: 'oc-user' }, 1_000);
    // Wrong signing key and wrong claim set: the audience check is defence in
    // depth on top of per-server keys, not a replacement for them.
    expect(() => service.verify(worker, { purpose: 'arc', botName: 'pm', chatId: 'oc-user' })).toThrow();
    const verifier = new ArcCapabilityVerifier(
      [createPublicKey(readFileSync(path.join(dir, 'arc-capability.pub')))],
      () => 2_000,
    );
    expect(() => verifier.verify(worker)).toThrow();
  });

  it('gives every registered server its own keypair and refuses shared verification material', () => {
    const dir = keysDir();
    const audiences = EXECUTION_MCP_SERVERS.filter(isLoopbackProxy).map((server) => server.id);
    const material = audiences.map((id) => readFileSync(path.join(dir, `${id}-capability.pub`), 'utf8'));
    expect(new Set(material).size).toBe(audiences.length);

    expect(() => assertDistinctKeyMaterial(dir)).not.toThrow();
    // The same key with a different PEM newline encoding must still collide;
    // comparison is over canonical SPKI bytes, not raw file text.
    writeFileSync(path.join(dir, `${audiences[1]}-capability.pub`), material[0].replaceAll('\n', '\r\n'), {
      encoding: 'utf8',
      mode: 0o600,
    });
    expect(() => assertDistinctKeyMaterial(dir)).toThrow(/share verification material/i);
  });
});
