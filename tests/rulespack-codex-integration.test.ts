import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RENDER_BEGIN, RENDER_END } from '@metabot/rulespack';
import type { BotConfigBase } from '../src/config.js';
import { SessionManager } from '../src/engines/claude/session-manager.js';
import { CodexExecutor } from '../src/engines/codex/executor.js';
import { NodeCliProcessRunner } from '../packages/worker-runner-mcp/src/process-runner.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} } as any;
const temporary: string[] = [];
const actualInjection = `${RENDER_BEGIN}\nApproved rule\n${RENDER_END}`;

afterEach(() => {
  delete process.env.SESSION_STORE_DIR;
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function config(): BotConfigBase {
  return {
    name: 'admin',
    engine: 'codex',
    claude: {
      defaultWorkingDirectory: '/tmp',
      maxTurns: undefined,
      maxBudgetUsd: undefined,
      model: undefined,
      apiKey: undefined,
      outputsBaseDir: '/tmp',
      downloadsDir: '/tmp',
      backend: 'pty',
    },
  };
}

describe('RulesPack Codex integration hooks', () => {
  it('places only RulesPack rendered bytes before the user body and existing context', () => {
    const prompt = (new CodexExecutor(config(), logger) as any).buildPromptWithContext(
      'actual user prompt',
      undefined,
      { botName: 'admin', chatId: 'chat-a', engine: 'codex' },
      actualInjection,
    ) as string;
    expect(prompt.indexOf(actualInjection)).toBe(0);
    expect(prompt.indexOf('actual user prompt')).toBeGreaterThan(prompt.indexOf(actualInjection));
    expect(prompt.indexOf('## Current MetaBot Context')).toBeGreaterThan(prompt.indexOf('actual user prompt'));
    expect(prompt).not.toContain('packDigest');
    expect(prompt).not.toContain('subjectFingerprint');
  });

  it('reuses an unchanged digest and recycles changed/enforce-off sessions only at boundaries', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rulespack-session-'));
    temporary.push(directory);
    process.env.SESSION_STORE_DIR = directory;
    const sessions = new SessionManager('/tmp', logger, 'rulespack-test');
    sessions.setSessionId('chat-a', 'session-1', 'codex');
    expect(sessions.applyRulesPackDigest('chat-a', 'digest-a')).toBe(true);
    expect(sessions.getSession('chat-a').sessionId).toBeUndefined();
    sessions.setSessionId('chat-a', 'session-2', 'codex');
    expect(sessions.applyRulesPackDigest('chat-a', 'digest-a')).toBe(false);
    expect(sessions.getSession('chat-a').sessionId).toBe('session-2');
    expect(sessions.applyRulesPackDigest('chat-a', 'digest-b')).toBe(true);
    sessions.setSessionId('chat-a', 'session-3', 'codex');
    expect(sessions.applyRulesPackDigest('chat-a', undefined)).toBe(true);
    expect(sessions.getSession('chat-a').sessionId).toBeUndefined();
    sessions.destroy();
  });

  it('uses the same truthful pre-user order for detached Codex workers only', () => {
    const runner = new NodeCliProcessRunner({
      executables: { codex: '/bin/codex', claude: '/bin/claude', kimi: '/bin/kimi' },
    });
    const markInjected = () => undefined;
    const markRejected = () => undefined;
    const codex = runner.buildCommand({
      id: 'worker-1',
      launchId: 'launch-1',
      engine: 'codex',
      workdir: '/tmp',
      prompt: 'child prompt',
      rulesPack: { injectionText: 'RULESPACK PRELUDE', packDigest: 'digest', markInjected, markRejected },
    });
    expect(codex.stdin).toBe('RULESPACK PRELUDE\n\n---\n\nchild prompt');
    const claude = runner.buildCommand({
      id: 'worker-2',
      launchId: 'launch-2',
      engine: 'claude',
      workdir: '/tmp',
      prompt: 'child prompt',
      rulesPack: { injectionText: 'MUST NOT APPLY', packDigest: 'digest', markInjected, markRejected },
    });
    expect(claude.stdin).toBe('child prompt');
  });

  it.each([
    { name: 'fresh', sessionId: undefined },
    { name: 'resume', sessionId: 'session-existing' },
  ])('writes the real delimiter through stdin and records accepted $name transport', async ({ sessionId }) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rulespack-stdin-accept-'));
    temporary.push(directory);
    const executable = path.join(directory, 'codex');
    const argvFile = path.join(directory, 'argv');
    const stdinFile = path.join(directory, 'stdin');
    fs.writeFileSync(
      executable,
      `#!/bin/sh
: > "$CAPTURE_ARGV"
for arg in "$@"; do printf '%s\\n' "$arg" >> "$CAPTURE_ARGV"; done
cat > "$CAPTURE_STDIN"
printf '%s\\n' '{"type":"thread.started","thread_id":"thread-rulespack"}'
printf '%s\\n' '{"type":"item.completed","item":{"id":"msg-1","type":"agent_message","text":"done"}}'
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
`,
      { mode: 0o755 },
    );
    const cfg = config();
    cfg.codex = {
      executable,
      env: { CAPTURE_ARGV: argvFile, CAPTURE_STDIN: stdinFile },
    };
    const markInjected = vi.fn();
    const markRejected = vi.fn();
    const handle = new CodexExecutor(cfg, logger).startExecution({
      prompt: 'actual user prompt',
      cwd: directory,
      sessionId,
      abortController: new AbortController(),
      rulesPack: { injectionText: actualInjection, markInjected, markRejected },
    });
    for await (const _message of handle.stream) {
      // Drain through the terminal result.
    }

    const expectedPrompt = `${actualInjection}\n\n---\n\nactual user prompt`;
    expect(fs.readFileSync(stdinFile, 'utf8')).toBe(expectedPrompt);
    const argv = fs.readFileSync(argvFile, 'utf8').trimEnd().split('\n');
    expect(argv).not.toContain(expectedPrompt);
    expect(argv.slice(argv.indexOf('exec'))).toEqual(sessionId
      ? ['exec', 'resume', '--json', '--skip-git-repo-check', sessionId, '-']
      : ['exec', '--json', '--color', 'never', '--skip-git-repo-check', '-']);
    expect(markInjected).toHaveBeenCalledOnce();
    expect(markRejected).not.toHaveBeenCalled();
  });

  it('records rejection instead of injection when Codex closes stdin early', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rulespack-stdin-reject-'));
    temporary.push(directory);
    const executable = path.join(directory, 'codex');
    fs.writeFileSync(executable, '#!/bin/sh\nexec 0<&-\nsleep 0.1\nexit 7\n', { mode: 0o755 });
    const cfg = config();
    cfg.codex = { executable };
    const markInjected = vi.fn();
    const markRejected = vi.fn();
    const handle = new CodexExecutor(cfg, logger).startExecution({
      prompt: 'x'.repeat(2 * 1024 * 1024),
      cwd: directory,
      abortController: new AbortController(),
      rulesPack: { injectionText: actualInjection, markInjected, markRejected },
    });
    for await (const _message of handle.stream) {
      // Drain the stdin failure result.
    }
    expect(markInjected).not.toHaveBeenCalled();
    expect(markRejected).toHaveBeenCalledOnce();
  });

  it('keeps an accepted receipt when Codex fails after reading the complete prompt', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rulespack-post-input-failure-'));
    temporary.push(directory);
    const executable = path.join(directory, 'codex');
    fs.writeFileSync(executable, '#!/bin/sh\ncat >/dev/null\nexit 7\n', { mode: 0o755 });
    const cfg = config();
    cfg.codex = { executable };
    const markInjected = vi.fn();
    const markRejected = vi.fn();
    const handle = new CodexExecutor(cfg, logger).startExecution({
      prompt: 'accepted before execution failure',
      cwd: directory,
      abortController: new AbortController(),
      rulesPack: { injectionText: actualInjection, markInjected, markRejected },
    });
    for await (const _message of handle.stream) {
      // Drain the non-zero terminal result.
    }
    expect(markInjected).toHaveBeenCalledOnce();
    expect(markRejected).not.toHaveBeenCalled();
  });

  it('records rejection when cancellation happens before prompt delivery', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rulespack-stdin-cancel-'));
    temporary.push(directory);
    const executable = path.join(directory, 'codex');
    fs.writeFileSync(executable, '#!/bin/sh\nsleep 5\n', { mode: 0o755 });
    const cfg = config();
    cfg.codex = { executable };
    const markInjected = vi.fn();
    const markRejected = vi.fn();
    const abortController = new AbortController();
    abortController.abort();
    const handle = new CodexExecutor(cfg, logger).startExecution({
      prompt: 'cancelled before delivery',
      cwd: directory,
      abortController,
      rulesPack: { injectionText: actualInjection, markInjected, markRejected },
    });
    for await (const _message of handle.stream) {
      // Drain the cancelled terminal result.
    }
    expect(markInjected).not.toHaveBeenCalled();
    expect(markRejected).toHaveBeenCalledOnce();
  });

  it('records prepared input rejection when Codex spawn fails before acceptance', async () => {
    const broken = config();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rulespack-spawn-reject-'));
    temporary.push(directory);
    const nonExecutable = path.join(directory, 'codex');
    fs.writeFileSync(nonExecutable, '#!/bin/sh\nexit 0\n', { mode: 0o600 });
    broken.codex = { executable: nonExecutable };
    const markInjected = vi.fn();
    const markRejected = vi.fn();
    const handle = new CodexExecutor(broken, logger).startExecution({
      prompt: 'will not spawn',
      cwd: '/tmp',
      abortController: new AbortController(),
      rulesPack: { injectionText: 'RULE', markInjected, markRejected },
    });
    for await (const _message of handle.stream) {
      // Drain the terminal error so the child error path completes.
    }
    expect(markInjected).not.toHaveBeenCalled();
    expect(markRejected).toHaveBeenCalledOnce();
  });
});
