import { describe, expect, it } from 'vitest';
import { classifyClaudeInputReadiness } from '../src/engines/claude/pty/pty-session.js';

describe('classifyClaudeInputReadiness', () => {
  it('treats a plain input prompt as idle', () => {
    expect(classifyClaudeInputReadiness('Welcome\n❯ ')).toMatchObject({
      hasInputBox: true,
      running: false,
      menuUp: false,
      idle: true,
    });
  });

  it('does not treat a running turn as idle', () => {
    expect(classifyClaudeInputReadiness('Thinking...\nEsc to interrupt\n❯ ')).toMatchObject({
      hasInputBox: true,
      running: true,
      idle: false,
    });
  });

  it('does not treat a blocking selection menu as idle', () => {
    expect(
      classifyClaudeInputReadiness('Question?\n❯ 1. Yes\n  2. No\nEnter to select'),
    ).toMatchObject({
      hasInputBox: true,
      menuUp: true,
      idle: false,
    });
  });
});
