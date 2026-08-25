import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import {
  composeClaudeSystemAppend,
  DEFAULT_CLAUDE_MAX_BUDGET_USD,
  DEFAULT_CLAUDE_MAX_TURNS,
} from '../src/engines/claude/executor.js';
import { PersistentClaudeExecutor } from '../src/engines/claude/persistent-executor.js';
import { equalRulesPack } from '../src/engines/claude/executor-registry.js';
import { createHookBridge } from '../src/engines/claude/pty/hook-bridge.js';

const logger = {
  child: () => logger,
  info() {},
  warn() {},
  error() {},
  debug() {},
} as any;

describe('Claude RulesPack delivery', () => {
  it('keeps direct Claude execution bounded when bot config omits limits', () => {
    expect(DEFAULT_CLAUDE_MAX_TURNS).toBe(50);
    expect(DEFAULT_CLAUDE_MAX_BUDGET_USD).toBe(3);
  });

  it('places RulesPack before ordinary MetaBot system appendices', () => {
    const result = composeClaudeSystemAppend('RULESPACK DATA', '\n\n## Output Files\n/path');
    expect(result.indexOf('RULESPACK DATA')).toBeLessThan(result.indexOf('## Output Files'));
  });

  it('forces persistent executor replacement when digest or rendered policy changes', () => {
    expect(equalRulesPack(
      { packDigest: 'digest-a', injectionText: 'policy-a' },
      { packDigest: 'digest-a', injectionText: 'policy-a' },
    )).toBe(true);
    expect(equalRulesPack(
      { packDigest: 'digest-a', injectionText: 'policy-a' },
      { packDigest: 'digest-b', injectionText: 'policy-a' },
    )).toBe(false);
    expect(equalRulesPack(
      { packDigest: 'digest-a', injectionText: 'policy-a' },
      { packDigest: 'digest-a', injectionText: 'policy-b' },
    )).toBe(false);
  });

  it('materializes PTY system policy in a private cleanup-owned file', async () => {
    const bridge = createHookBridge();
    const file = await bridge.writePrivateFile('system-prompt.md', 'RULESPACK DATA');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toBe('RULESPACK DATA');
    await bridge.dispose();
    expect(existsSync(file)).toBe(false);
  });

  it('records one persistent-turn injection acknowledgement and never reverses it', () => {
    const executor = new PersistentClaudeExecutor({ cwd: process.cwd(), logger });
    (executor as any).state = 'ready';
    const markInjected = vi.fn();
    const markRejected = vi.fn();
    executor.nextTurn('hello', { markInjected, markRejected });
    const turn = (executor as any).activeTurn;
    (executor as any).acceptTurnRulesPack(turn);
    (executor as any).acceptTurnRulesPack(turn);
    (executor as any).rejectTurnRulesPack(turn, new Error('late failure'));
    expect(markInjected).toHaveBeenCalledTimes(1);
    expect(markRejected).not.toHaveBeenCalled();
  });

  it('records one rejection when a persistent turn fails before first output', () => {
    const executor = new PersistentClaudeExecutor({ cwd: process.cwd(), logger });
    (executor as any).state = 'ready';
    const markInjected = vi.fn();
    const markRejected = vi.fn();
    executor.nextTurn('hello', { markInjected, markRejected });
    const turn = (executor as any).activeTurn;
    (executor as any).rejectTurnRulesPack(turn, new Error('startup failed'));
    (executor as any).rejectTurnRulesPack(turn, new Error('duplicate'));
    expect(markRejected).toHaveBeenCalledTimes(1);
    expect(markInjected).not.toHaveBeenCalled();
  });
});
