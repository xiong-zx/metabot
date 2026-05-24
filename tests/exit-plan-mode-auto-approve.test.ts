import { describe, it, expect } from 'vitest';
import { PersistentClaudeExecutor } from '../src/engines/claude/persistent-executor.js';

/**
 * Claude Code TUI gates ExitPlanMode behind an interactive "Approve plan"
 * prompt; the SDK keeps the agent in plan mode until the prompt is
 * answered, even under `permissionMode: 'bypassPermissions'`. MetaBot has
 * no Feishu-side equivalent of that prompt, so without a hook the agent
 * would hang the moment it tried to leave plan mode.
 *
 * The fix: a PreToolUse hook with matcher `ExitPlanMode` that returns
 * `permissionDecision: 'allow'` synchronously, mirroring the auto-approve
 * posture of the rest of the bridge.
 */

const mockLogger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
} as any;

function makeExec(): PersistentClaudeExecutor {
  return new PersistentClaudeExecutor({
    cwd: '/tmp',
    logger: mockLogger,
    idleTimeoutMs: 0,
  });
}

describe('PersistentClaudeExecutor ExitPlanMode auto-approve hook', () => {
  function getExitPlanModeHook(exec: PersistentClaudeExecutor) {
    const hooks = (exec as any).buildHooks();
    const entry = hooks.PreToolUse.find((e: any) => e.matcher === 'ExitPlanMode');
    expect(entry, 'PreToolUse entry for ExitPlanMode must be registered').toBeDefined();
    return entry.hooks[0] as (input: any) => Promise<Record<string, unknown>>;
  }

  it('returns permissionDecision=allow without touching tool_input', async () => {
    const exec = makeExec();
    const hook = getExitPlanModeHook(exec);

    const result = await hook({
      hook_event_name: 'PreToolUse',
      tool_name: 'ExitPlanMode',
      tool_use_id: 'toolu_plan_1',
      tool_input: { plan: '1. read files\n2. write code' },
    });

    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
      },
    });
  });

  it('resolves synchronously (does not pause for user input)', async () => {
    const exec = makeExec();
    const hook = getExitPlanModeHook(exec);

    let resolved = false;
    const p = hook({
      hook_event_name: 'PreToolUse',
      tool_name: 'ExitPlanMode',
      tool_use_id: 'toolu_plan_2',
      tool_input: { plan: 'plan body' },
    }).then((r) => { resolved = true; return r; });

    // The AskUserQuestion hook would still be pending here (waiting on the
    // bridge). Auto-approve must complete in the same microtask tick.
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(true);
    await p;
  });

  it('does not register a pending resolver (only AskUserQuestion uses that map)', async () => {
    const exec = makeExec();
    const hook = getExitPlanModeHook(exec);

    await hook({
      hook_event_name: 'PreToolUse',
      tool_name: 'ExitPlanMode',
      tool_use_id: 'toolu_plan_3',
      tool_input: { plan: 'plan body' },
    });

    expect((exec as any).pendingQuestionResolvers.size).toBe(0);
  });

  it('AskUserQuestion entry still lives at PreToolUse[0] (no ordering regression)', () => {
    const exec = makeExec();
    const hooks = (exec as any).buildHooks();
    expect(hooks.PreToolUse[0].matcher).toBe('AskUserQuestion');
  });
});
