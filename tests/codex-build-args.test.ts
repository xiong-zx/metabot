import { describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCodexArgs, buildCodexEnv, resolveCodexModelMetadata, resolveCodexPath } from '../src/engines/codex/executor.js';
import type { McpEntry } from '../src/engines/mcp-entries.js';
import { type CodexBotConfig, normalizeCodexReasoningEffort } from '../src/config.js';

describe('buildCodexArgs', () => {
  const cwd = '/work/proj';

  it('defaults approval policy to "never" and sandbox to "workspace-write"', () => {
    const args = buildCodexArgs({}, cwd, undefined, undefined);
    expect(args).toEqual([
      '-a', 'never',
      '--sandbox', 'workspace-write',
      '-C', cwd,
      'exec', '--json', '--color', 'never', '--skip-git-repo-check', '-',
    ]);
  });

  it('honors explicit approvalPolicy and sandbox', () => {
    const cfg: CodexBotConfig = { approvalPolicy: 'on-failure', sandbox: 'read-only' };
    const args = buildCodexArgs(cfg, cwd, undefined, undefined);
    expect(args.slice(0, 4)).toEqual(['-a', 'on-failure', '--sandbox', 'read-only']);
  });

  it('replaces policy/sandbox flags when dangerouslyBypassApprovalsAndSandbox is set', () => {
    const cfg: CodexBotConfig = {
      dangerouslyBypassApprovalsAndSandbox: true,
      approvalPolicy: 'on-failure',
      sandbox: 'read-only',
    };
    const args = buildCodexArgs(cfg, cwd, undefined, undefined);
    expect(args[0]).toBe('--dangerously-bypass-approvals-and-sandbox');
    expect(args).not.toContain('-a');
    expect(args).not.toContain('--sandbox');
  });

  it('passes model and profile when provided', () => {
    const cfg: CodexBotConfig = { profile: 'staging' };
    const args = buildCodexArgs(cfg, cwd, undefined, 'gpt-5.5');
    expect(args).toContain('-m');
    expect(args[args.indexOf('-m') + 1]).toBe('gpt-5.5');
    expect(args).toContain('-p');
    expect(args[args.indexOf('-p') + 1]).toBe('staging');
  });

  it('passes Codex OpenAI-compatible base URL as a config override', () => {
    const cfg: CodexBotConfig = { baseUrl: 'https://gateway.example.com/openai/v1' };
    const args = buildCodexArgs(cfg, cwd, undefined, 'gpt-5.5');
    expect(args).toContain('-c');
    expect(args[args.indexOf('-c') + 1]).toBe('openai_base_url="https://gateway.example.com/openai/v1"');
    expect(args.indexOf('-c')).toBeLessThan(args.indexOf('exec'));
  });

  it('passes Codex reasoning effort as a config override', () => {
    const args = buildCodexArgs({}, cwd, undefined, 'gpt-5.5', 'high');
    expect(args).toContain('-c');
    expect(args).toContain('model_reasoning_effort="high"');
    expect(args.indexOf('model_reasoning_effort="high"')).toBeLessThan(args.indexOf('exec'));
  });

  it('uses codex.reasoningEffort when no per-turn effort is provided', () => {
    const args = buildCodexArgs({ reasoningEffort: 'xhigh' }, cwd, undefined, undefined);
    expect(args).toContain('model_reasoning_effort="xhigh"');
  });

  it('passes max and ultra through as distinct Codex effort levels', () => {
    expect(normalizeCodexReasoningEffort('ultracode')).toBeUndefined();
    expect(normalizeCodexReasoningEffort('max')).toBe('max');
    expect(normalizeCodexReasoningEffort('ultra')).toBe('ultra');
    expect(buildCodexArgs({}, cwd, undefined, undefined, 'max')).toContain('model_reasoning_effort="max"');
    expect(buildCodexArgs({}, cwd, undefined, undefined, 'ultra')).toContain('model_reasoning_effort="ultra"');
  });

  it('appends extraArgs verbatim between global flags and the exec subcommand', () => {
    const cfg: CodexBotConfig = { extraArgs: ['--foo', 'bar baz', '--qux'] };
    const args = buildCodexArgs(cfg, cwd, undefined, undefined);
    const execIdx = args.indexOf('exec');
    expect(args.slice(execIdx - 3, execIdx)).toEqual(['--foo', 'bar baz', '--qux']);
  });

  it('adds per-invocation MCP overrides before operator extraArgs without token bytes', () => {
    const entries: McpEntry[] = [
      {
        name: 'metabot-worker',
        command: '/runtime with spaces/node_modules/.bin/metabot-"worker"',
        args: ['--path', 'C:\\private files\\proxy'],
        env: {
          METABOT_WORKER_PROXY_URL: 'http://127.0.0.1:9311/mcp',
          METABOT_WORKER_PROXY_CAPABILITY_FILE: '/private/token file',
        },
        codexToolsApprovalMode: 'approve',
      },
    ];
    const args = buildCodexArgs(
      { extraArgs: ['--operator-override'] },
      cwd,
      prompt,
      undefined,
      undefined,
      undefined,
      entries,
    );
    const joined = args.join('\n');

    expect(joined).toContain('mcp_servers.metabot-worker.command="/runtime with spaces/node_modules/.bin/metabot-\\"worker\\""');
    expect(joined).toContain('mcp_servers.metabot-worker.args=["--path","C:\\\\private files\\\\proxy"]');
    expect(joined).toContain('mcp_servers.metabot-worker.default_tools_approval_mode="approve"');
    expect(joined).toContain(
      'mcp_servers.metabot-worker.env.METABOT_WORKER_PROXY_CAPABILITY_FILE="/private/token file"',
    );
    expect(joined).not.toContain('CAPABILITY_TOKEN_SENTINEL');
    expect(args.indexOf('--operator-override')).toBeGreaterThan(args.findIndex((arg) => arg.includes('mcp_servers.')));
    expect(args.indexOf('--operator-override')).toBeLessThan(args.indexOf('exec'));
  });

  it('keeps argv byte-identical when no MCP entries are materialized', () => {
    const existing = buildCodexArgs({}, cwd, prompt, undefined, undefined, 'high');
    expect(buildCodexArgs({}, cwd, prompt, undefined, undefined, 'high', [])).toEqual(existing);
  });

  it('uses `exec resume <sessionId>` when a session id is provided', () => {
    const args = buildCodexArgs({}, cwd, 'sess-abc', undefined);
    const tail = args.slice(args.indexOf('exec'));
    expect(tail).toEqual(['exec', 'resume', '--json', '--skip-git-repo-check', 'sess-abc', '-']);
    // resume path does NOT pass --color never (Codex resume subcommand differs)
    expect(tail).not.toContain('--color');
  });

  it('passes `--color never` for fresh executions (no session id)', () => {
    const args = buildCodexArgs({}, cwd, undefined, undefined);
    const tail = args.slice(args.indexOf('exec'));
    expect(tail).toEqual(['exec', '--json', '--color', 'never', '--skip-git-repo-check', '-']);
  });

  it('never carries prompt bytes in argv', () => {
    const args = buildCodexArgs({}, cwd, undefined, undefined);
    expect(args.at(-1)).toBe('-');
  });

  it('infers Codex display model and context from CODEX_HOME files', () => {
    const priorCodexHome = process.env.CODEX_HOME;
    const dir = mkdtempSync(join(tmpdir(), 'metabot-codex-'));
    try {
      process.env.CODEX_HOME = dir;
      writeFileSync(join(dir, 'config.toml'), 'model = "gpt-test"\n');
      writeFileSync(join(dir, 'models_cache.json'), JSON.stringify({
        models: [
          { slug: 'gpt-test', context_window: 123456 },
          { slug: 'gpt-other', context_window: 999 },
        ],
      }));

      expect(resolveCodexModelMetadata({})).toEqual({
        model: 'gpt-test',
        contextWindow: 123456,
      });
    } finally {
      if (priorCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = priorCodexHome;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to PATH when an explicit Codex path no longer exists', () => {
    const priorPath = process.env.PATH;
    const priorExecutable = process.env.CODEX_EXECUTABLE_PATH;
    const dir = mkdtempSync(join(tmpdir(), 'metabot-codex-path-'));
    const fakeCodex = join(dir, 'codex');
    try {
      writeFileSync(fakeCodex, '#!/bin/sh\nexit 0\n');
      chmodSync(fakeCodex, 0o755);
      process.env.PATH = [dir, '/usr/bin', '/bin'].join(':');
      delete process.env.CODEX_EXECUTABLE_PATH;

      expect(resolveCodexPath(join(dir, 'missing-codex'))).toBe(fakeCodex);
    } finally {
      process.env.PATH = priorPath;
      if (priorExecutable === undefined) delete process.env.CODEX_EXECUTABLE_PATH;
      else process.env.CODEX_EXECUTABLE_PATH = priorExecutable;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('buildCodexEnv', () => {
  it('normalizes explicit codex.apiKey to OPENAI_API_KEY and removes conflicting auth env vars', () => {
    const env = buildCodexEnv(
      { apiKey: 'sk-explicit' },
      {
        OPENAI_API_KEY: 'sk-openai',
        CODEX_API_KEY: 'sk-codex',
        CODEX_ACCESS_TOKEN: 'tok',
        PATH: '/bin',
      },
    );
    expect(env.OPENAI_API_KEY).toBe('sk-explicit');
    expect(env.CODEX_API_KEY).toBeUndefined();
    expect(env.CODEX_ACCESS_TOKEN).toBeUndefined();
    expect(env.PATH).toBe('/bin');
  });

  it('preserves env-based Codex auth when no explicit apiKey is configured', () => {
    const env = buildCodexEnv(
      {},
      {
        CODEX_API_KEY: 'sk-from-env',
        PATH: '/bin',
      },
    );
    expect(env.CODEX_API_KEY).toBe('sk-from-env');
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it('lets codex.env provide API-key auth for a single bot', () => {
    const env = buildCodexEnv(
      { env: { OPENAI_API_KEY: 'sk-bot-env' } },
      {
        PATH: '/bin',
      },
    );
    expect(env.OPENAI_API_KEY).toBe('sk-bot-env');
    expect(env.PATH).toBe('/bin');
  });

  it('strips bridge local-admin credentials but preserves the scoped Team capability', () => {
    const env = buildCodexEnv(
      { env: { METABOT_API_SECRET: 'config-spoof' } },
      {
        API_SECRET: 'bridge-admin',
        METABOT_API_SECRET: 'bridge-admin-alias',
        METABOT_AUTH: 'Authorization: Bearer bridge-admin',
        METABOT_TEAM_CAPABILITY: 'signed-scoped-token',
        METABOT_BOT_NAME: 'pm-codex',
        METABOT_CHAT_ID: 'teaminst:one:coder',
      },
    );
    expect(env.API_SECRET).toBeUndefined();
    expect(env.METABOT_API_SECRET).toBeUndefined();
    expect(env.METABOT_AUTH).toBeUndefined();
    expect(env.METABOT_TEAM_CAPABILITY).toBe('signed-scoped-token');
    expect(env.METABOT_BOT_NAME).toBe('pm-codex');
  });
});
