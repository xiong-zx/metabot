import { describe, expect, it } from 'vitest';
import { resolveBtwTarget } from '../src/bridge/message-bridge.js';

const MAIN = 'main-session-id';
const BRANCH = { sessionId: 'branch-session-id', engine: 'codex' as const };

describe('resolveBtwTarget (/btw vs /btwc)', () => {
  it('/btw always forks a fresh branch off the main session', () => {
    expect(resolveBtwTarget(false, BRANCH, 'codex', MAIN)).toEqual({ sessionId: MAIN, mode: 'fork' });
  });

  it('/btwc continues the remembered branch on the same engine', () => {
    expect(resolveBtwTarget(true, BRANCH, 'codex', MAIN)).toEqual({ sessionId: 'branch-session-id', mode: 'continue' });
  });

  it('/btwc with no branch yet behaves like /btw', () => {
    expect(resolveBtwTarget(true, undefined, 'codex', MAIN)).toEqual({ sessionId: MAIN, mode: 'fork' });
  });

  it('/btwc after an engine switch falls back to a fresh fork', () => {
    expect(resolveBtwTarget(true, BRANCH, 'claude', MAIN)).toEqual({ sessionId: MAIN, mode: 'fork' });
  });

  it('/btw with no main session yet starts a fresh sessionless branch', () => {
    expect(resolveBtwTarget(false, undefined, 'claude', undefined)).toEqual({ sessionId: undefined, mode: 'fork' });
  });
});
