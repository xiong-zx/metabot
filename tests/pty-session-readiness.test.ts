import { describe, expect, it } from 'vitest';
import { classifyClaudeInputReadiness, isClaudeResumeSummaryDialog } from '../src/engines/claude/pty/pty-session.js';

describe('classifyClaudeInputReadiness', () => {
  it('treats a plain input prompt as idle', () => {
    expect(classifyClaudeInputReadiness('Welcome\n❯ ')).toMatchObject({
      hasInputBox: true,
      running: false,
      menuUp: false,
      idle: true,
    });
  });

  it('treats the newer Claude prompt marker as idle', () => {
    expect(
      classifyClaudeInputReadiness(
        'Press Ctrl-C again to exit\n⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent',
      ),
    ).toMatchObject({
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

  it('does not treat a newer-prompt running turn as idle', () => {
    expect(
      classifyClaudeInputReadiness('Thinking...\nEsc to interrupt\n⏵⏵ '),
    ).toMatchObject({
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

describe('isClaudeResumeSummaryDialog', () => {
  const resumeDialog = `
    This session is 6h 46m old and 201.8k tokens.

    Resuming the full session will consume a substantial portion of your usage limits.

    ❯ 1. Resume from summary (recommended)
      2. Resume full session as-is
      3. Don't ask me again

    Enter to confirm · Esc to cancel
  `;

  it('recognises the long-session resume summary prompt', () => {
    expect(isClaudeResumeSummaryDialog(resumeDialog)).toBe(true);
  });

  it('keeps the resume prompt classified as a blocking menu', () => {
    expect(classifyClaudeInputReadiness(resumeDialog)).toMatchObject({
      hasInputBox: true,
      menuUp: true,
      idle: false,
    });
  });

  it('does not match unrelated numbered menus', () => {
    expect(isClaudeResumeSummaryDialog('Question?\n❯ 1. Yes\n  2. No\nEnter to select')).toBe(false);
  });
});
