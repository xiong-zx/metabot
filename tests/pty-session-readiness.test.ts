import { describe, expect, it } from 'vitest';
import {
  classifyClaudeInputReadiness,
  classifyClaudeSubmissionAcknowledgement,
  hasClaudePromptText,
  hasClaudeRunningFooter,
  isClaudeResumeSummaryDialog,
  RESUME_SUMMARY_READY_TIMEOUT_MS,
} from '../src/engines/claude/pty/pty-session.js';

describe('classifyClaudeInputReadiness', () => {
  it('treats a plain input prompt as idle', () => {
    expect(classifyClaudeInputReadiness('Welcome\n❯ ')).toMatchObject({
      hasInputBox: true,
      running: false,
      menuUp: false,
      idle: true,
    });
  });

  it('does not confuse the double-chevron status footer with an input prompt', () => {
    expect(
      classifyClaudeInputReadiness(
        'Press Ctrl-C again to exit\n⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent',
      ),
    ).toMatchObject({
      hasInputBox: false,
      running: false,
      menuUp: false,
      idle: false,
    });
  });

  it('treats a real single-chevron input prompt as idle', () => {
    expect(classifyClaudeInputReadiness('Welcome\n⏵ ')).toMatchObject({
      hasInputBox: true,
      running: false,
      menuUp: false,
      idle: true,
    });
  });

  it('does not treat a running turn as idle', () => {
    expect(classifyClaudeInputReadiness('Thinking...\n❯ \nEsc to interrupt')).toMatchObject({
      hasInputBox: true,
      running: true,
      idle: false,
    });
  });

  it('does not treat a newer-prompt running turn as idle', () => {
    expect(
      classifyClaudeInputReadiness('Thinking...\n⏵⏵ Esc to interrupt'),
    ).toMatchObject({
      hasInputBox: false,
      running: true,
      idle: false,
    });
  });

  it('ignores a running-marker quote in completed answer text above the prompt', () => {
    const screen = [
      'A real model turn should show the "esc to interrupt" footer quickly.',
      '或者两个一起。',
      '────────────────────────────────────────',
      '❯\u00a0',
      '────────────────────────────────────────',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent',
    ].join('\n');

    expect(hasClaudeRunningFooter(screen)).toBe(false);
    expect(classifyClaudeInputReadiness(screen)).toMatchObject({
      hasInputBox: true,
      running: false,
      idle: true,
    });
  });

  it('distinguishes text still in the prompt from a cleared input box', () => {
    expect(hasClaudePromptText('❯ pending message')).toBe(true);
    expect(hasClaudePromptText('❯\u00a0\n──\n⏵⏵ bypass permissions on')).toBe(false);
  });

  it('does not acknowledge redraws while submitted text remains in the prompt', () => {
    expect(
      classifyClaudeSubmissionAcknowledgement(
        '❯ partially rendered',
        '❯ full pending message\n──\n⏵⏵ bypass permissions on',
      ),
    ).toBeNull();
  });

  it('acknowledges a cleared prompt or a real running footer', () => {
    expect(
      classifyClaudeSubmissionAcknowledgement(
        '❯ pending message',
        'answer\n──\n❯ \n──\n⏵⏵ bypass permissions on',
      ),
    ).toBe('accepted');
    expect(
      classifyClaudeSubmissionAcknowledgement(
        '❯ pending message',
        '──\n❯ \n──\n⏵⏵ bypass permissions on · Esc to interrupt',
      ),
    ).toBe('running');
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

  it('allows model-backed compaction to outlive the normal startup timeout', () => {
    expect(RESUME_SUMMARY_READY_TIMEOUT_MS).toBe(10 * 60_000);
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
