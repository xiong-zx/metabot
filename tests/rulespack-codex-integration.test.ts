import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BotConfigBase } from '../src/config.js';
import { SessionManager } from '../src/engines/claude/session-manager.js';
import { CodexExecutor } from '../src/engines/codex/executor.js';
import { NodeCliProcessRunner } from '../packages/worker-runner-mcp/src/process-runner.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} } as any;
const temporary: string[] = [];

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
    const injection = '<<< BEGIN RULESPACK DATA v1 >>>\nApproved rule\n<<< END RULESPACK DATA v1 >>>';
    const prompt = (new CodexExecutor(config(), logger) as any).buildPromptWithContext(
      'actual user prompt',
      undefined,
      { botName: 'admin', chatId: 'chat-a', engine: 'codex' },
      injection,
    ) as string;
    expect(prompt.indexOf(injection)).toBe(0);
    expect(prompt.indexOf('actual user prompt')).toBeGreaterThan(prompt.indexOf(injection));
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
