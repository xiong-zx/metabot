/**
 * Regression: `mcpConfigPath` must reach the spawned `claude` as --mcp-config.
 *
 * This is the last hop of the chain (executor → ptyQuery → session → argv); the
 * two hops above it are covered by persistent-executor-mcp / pty-query-mcp-config.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** ensureFolderTrusted() writes ~/.claude.json — redirect HOME so the real one is untouched. */
const fakeHome = vi.hoisted(() => ({ dir: '' }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, default: { ...actual, homedir: () => fakeHome.dir }, homedir: () => fakeHome.dir };
});

const spawnMock = vi.hoisted(() => vi.fn(() => ({
  onData: vi.fn(),
  onExit: vi.fn(),
  write: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn(),
  pid: 4242,
})));

vi.mock('node-pty', () => ({ spawn: spawnMock, default: { spawn: spawnMock } }));

import { createPtyClaudeSession } from '../src/engines/claude/pty/pty-session.js';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as any;

function spawnArgs(): string[] {
  expect(spawnMock).toHaveBeenCalledTimes(1);
  return spawnMock.mock.calls[0][1] as unknown as string[];
}

describe('pty-session --mcp-config argument', () => {
  beforeEach(() => {
    fakeHome.dir = mkdtempSync(join(tmpdir(), 'metabot-pty-home-'));
    spawnMock.mockClear();
  });

  afterEach(() => {
    rmSync(fakeHome.dir, { recursive: true, force: true });
  });

  it('passes --mcp-config when a config path is supplied', () => {
    createPtyClaudeSession({
      cwd: '/tmp',
      settingsPath: '/tmp/fake-settings.json',
      mcpConfigPath: '/tmp/fake-mcp-config.json',
      logger,
    });

    const args = spawnArgs();
    const at = args.indexOf('--mcp-config');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(args[at + 1]).toBe('/tmp/fake-mcp-config.json');
  });

  it('omits --mcp-config when no config path is supplied', () => {
    createPtyClaudeSession({
      cwd: '/tmp',
      settingsPath: '/tmp/fake-settings.json',
      logger,
    });

    expect(spawnArgs()).not.toContain('--mcp-config');
  });

  it('never passes --strict-mcp-config', () => {
    // --strict-mcp-config would suppress every OTHER MCP source, silently
    // killing the user's own claude.ai connectors. Ours must layer on top.
    createPtyClaudeSession({
      cwd: '/tmp',
      settingsPath: '/tmp/fake-settings.json',
      mcpConfigPath: '/tmp/fake-mcp-config.json',
      logger,
    });

    expect(spawnArgs()).not.toContain('--strict-mcp-config');
  });

  it('passes the configured Claude model unchanged to the interactive spawn', () => {
    createPtyClaudeSession({
      cwd: '/tmp',
      settingsPath: '/tmp/fake-settings.json',
      model: 'claude-fable-5',
      logger,
    });

    const args = spawnArgs();
    const at = args.indexOf('--model');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(args[at + 1]).toBe('claude-fable-5');
  });
});
