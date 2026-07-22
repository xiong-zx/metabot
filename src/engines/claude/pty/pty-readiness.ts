const INPUT_PROMPT_LINE_RE = /^\s*(?:❯|⏵(?!⏵))/u;
const RUNNING_MARKER = 'esctointerrupt';

export interface ClaudeInputReadiness {
  hasInputBox: boolean;
  running: boolean;
  menuUp: boolean;
  idle: boolean;
}

export type ClaudeSubmissionAcknowledgement = 'running' | 'accepted';

function activeClaudeUi(screen: string): string {
  const lines = screen.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (INPUT_PROMPT_LINE_RE.test(lines[i])) return lines.slice(i).join('\n');
  }

  // Older Claude builds can expose only the bottom status row while redrawing.
  // Keep the fallback bounded so answer text elsewhere in the viewport cannot
  // impersonate a live footer.
  return lines.slice(-8).join('\n');
}

/** True only when Claude's active prompt/footer says a model turn is running. */
export function hasClaudeRunningFooter(screen: string): boolean {
  return activeClaudeUi(screen).toLowerCase().replace(/\s+/g, '').includes(RUNNING_MARKER);
}

/** True when the current input-prompt row still contains unsubmitted text. */
export function hasClaudePromptText(screen: string): boolean {
  const lines = screen.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = /^\s*(?:❯|⏵(?!⏵))(.*)$/u.exec(lines[i]);
    if (match) return match[1].trim().length > 0;
  }
  return false;
}

export function classifyClaudeSubmissionAcknowledgement(
  submittedScreen: string,
  currentScreen: string,
): ClaudeSubmissionAcknowledgement | null {
  if (!currentScreen || currentScreen === submittedScreen) return null;
  const readiness = classifyClaudeInputReadiness(currentScreen);
  if (readiness.running) return 'running';
  if (!readiness.idle) return 'accepted';
  return hasClaudePromptText(currentScreen) ? null : 'accepted';
}

/**
 * Claude Code asks this question when an old/large session is resumed. The
 * recommended first option preserves continuity through a summary, but the
 * dialog blocks the normal input box until it is confirmed.
 */
export function isClaudeResumeSummaryDialog(screen: string): boolean {
  const sq = screen.toLowerCase().replace(/\s+/g, '');
  return (
    sq.includes('resumefromsummary') &&
    sq.includes('resumefullsessionas-is') &&
    sq.includes('entertoconfirm') &&
    /[❯⏵]1\./u.test(sq)
  );
}

export function classifyClaudeInputReadiness(screen: string): ClaudeInputReadiness {
  const ui = activeClaudeUi(screen);
  const uiLines = ui.split('\n');
  const sq = ui.toLowerCase().replace(/\s+/g, '');
  const running = hasClaudeRunningFooter(screen);
  const menuUp =
    sq.includes('entertoselect') ||
    sq.includes('ctrl-gtoedit') ||
    sq.includes('shift+tabtoapprove') ||
    /[❯⏵]\d\./u.test(sq); // pointer on a numbered menu option
  // The status footer starts with "⏵⏵ bypass permissions on". A broad search
  // for either prompt glyph therefore classifies a footer-only/half-exited TUI
  // as an input box and sends keystrokes into a process that cannot accept them.
  // Require a real single-glyph prompt row instead.
  const hasInputBox = uiLines.some((line) => INPUT_PROMPT_LINE_RE.test(line));
  return {
    hasInputBox,
    running,
    menuUp,
    idle: hasInputBox && !running && !menuUp,
  };
}
