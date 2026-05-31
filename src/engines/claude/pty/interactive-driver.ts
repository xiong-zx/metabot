/**
 * PTY backend — interactive-tool keystroke driver.
 *
 * The SDK delivers AskUserQuestion answers as a `tool_result` on the input
 * stream and auto-approves ExitPlanMode via `canUseTool`. A PTY can only TYPE
 * into the TUI, so for these two tools we instead drive the native blocking
 * menu with KEYSTROKES. Empirically (see memory/pty-backend.md):
 *
 *   - AskUserQuestion menu: `❯ 1. <label>` … `N. Type something` …
 *     Pressing the DIGIT N immediately selects AND submits option N (no Enter).
 *     "Type something" (= options.length+1) opens a free-text box: press its
 *     digit, type the text, press Enter.
 *   - ExitPlanMode menu: `Would you like to proceed?` then dynamic options.
 *     Digit-submit works; the "clear context" / "manually approve" options must
 *     be AVOIDED, so we parse the rendered menu to find the digit of
 *     "Yes, and bypass permissions" (matches the SDK's bypassPermissions allow).
 */

import type { Logger } from '../../../utils/logger.js';
import type {
  PtyClaudeSession,
  PtyInteractiveResponse,
  PtyInteractiveTool,
  PtyParsedQuestion,
} from './contract.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** How long to wait for a menu to render after the tool_use appears in jsonl. */
const MENU_WAIT_MS = 20_000;
const MENU_POLL_MS = 200;
/** Only inspect the tail of the snapshot — the current screen is at the end. */
const SNAPSHOT_TAIL = 4000;

/** Poll the session snapshot tail until `test` matches or we time out. */
async function waitForScreen(
  session: PtyClaudeSession,
  test: (tail: string) => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (test(session.snapshot().slice(-SNAPSHOT_TAIL))) return true;
    await sleep(MENU_POLL_MS);
  }
  return false;
}

/**
 * Drive the TUI menu for one detected interactive tool, per the executor's
 * response. Best-effort: logs and returns on failure (the 6-min hook timeout /
 * turn abort is the backstop). Never throws.
 */
export async function driveInteractiveTool(args: {
  session: PtyClaudeSession;
  tool: PtyInteractiveTool;
  response: PtyInteractiveResponse;
  logger: Logger;
}): Promise<void> {
  const { session, tool, response, logger } = args;
  try {
    if (tool.name === 'ExitPlanMode') {
      if (response.kind === 'cancel') {
        // User chose "Keep planning" (or timed out into it). Esc cancels the
        // approval menu, leaving claude in plan mode awaiting the user's next
        // message — the mirror of approveExitPlanMode's proceed path.
        logger.info({ toolUseId: tool.toolUseId }, 'pty-driver: keeping plan mode (Esc)');
        session.sendKeys('\x1b');
        return;
      }
      await approveExitPlanMode(session, logger);
      return;
    }
    if (tool.name === 'AskUserQuestion') {
      if (response.kind === 'cancel') {
        // User declined / timed out — Esc cancels the menu so claude unblocks.
        logger.info({ toolUseId: tool.toolUseId }, 'pty-driver: cancelling AskUserQuestion menu (Esc)');
        session.sendKeys('\x1b');
        return;
      }
      if (response.kind === 'answers') {
        await answerQuestions(session, response.answers, response.questions, logger);
      }
      return;
    }
    logger.warn({ tool: tool.name }, 'pty-driver: no handler for interactive tool');
  } catch (err) {
    logger.warn({ err, tool: tool.name }, 'pty-driver: drive failed');
  }
}

// ── ExitPlanMode ─────────────────────────────────────────────────────────────

/** Window to wait for the ExitPlanMode approval menu before assuming none. */
const EXITPLAN_MENU_WAIT_MS = 8_000;

async function approveExitPlanMode(session: PtyClaudeSession, logger: Logger): Promise<void> {
  // NOTE: the ANSI-stripped snapshot glues words together (no spaces), so all
  // screen matching is done on the squished (whitespace-removed) text.
  //
  // Under --dangerously-skip-permissions the interactive TUI usually
  // AUTO-PROCEEDS on ExitPlanMode with NO approval menu, so this is mostly
  // defensive. Match ONLY the real prompt ("Would you like to proceed?") — NOT
  // the persistent footer ("bypass permissions on ..."), which would false-fire.
  const ready = await waitForScreen(
    session,
    (t) => isExitPlanMenu(t),
    EXITPLAN_MENU_WAIT_MS,
  );
  if (!ready) {
    logger.info('pty-driver: no ExitPlanMode approval menu (auto-proceeded under bypass)');
    return;
  }
  // Let the menu settle (avoid catching a half-drawn frame).
  await sleep(300);
  const digit = findBypassPermissionsDigit(session.snapshot().slice(-SNAPSHOT_TAIL));
  if (digit === null) {
    logger.warn('pty-driver: could not locate "Yes, and bypass permissions" option');
    return;
  }
  logger.info({ digit }, 'pty-driver: approving ExitPlanMode (bypass permissions)');
  session.sendKeys(digit);
}

/**
 * Parse the ExitPlanMode menu and return the digit of the option that proceeds
 * WITHOUT clearing context or re-enabling permission prompts. Prefers an exact
 * "Yes, and bypass permissions"; falls back to the first "Yes," option that is
 * neither "clear context" nor "manually approve".
 */
export function findBypassPermissionsDigit(tail: string): string | null {
  // Menu lines look like "2. Yes, and bypass permissions", one option per line.
  // The ANSI strip glues intra-line words, so match against the squished line.
  // Last occurrence of each digit wins (most recent redraw).
  const byDigit = new Map<string, string>();
  for (const line of tail.split('\n')) {
    const sq = squish(line);
    const m = /(\d)\.(yes.*)/.exec(sq); // only "Yes,..." options interest us
    if (m) byDigit.set(m[1], m[2]);
  }
  if (byDigit.size === 0) return null;
  const entries = [...byDigit.entries()].sort((a, b) => Number(a[0]) - Number(b[0]));
  // 1) "and bypass permissions" but NOT "clear context".
  for (const [digit, text] of entries) {
    if (text.includes('bypasspermissions') && !text.includes('clearcontext')) return digit;
  }
  // 2) any "Yes," that's not clear-context and not manual-approve.
  for (const [digit, text] of entries) {
    if (!text.includes('clearcontext') && !text.includes('manuallyapprove')) return digit;
  }
  return null;
}

// ── AskUserQuestion ──────────────────────────────────────────────────────────

/** Window to wait for the final "Review your answers / Submit answers" screen. */
const REVIEW_WAIT_MS = 6_000;

/**
 * Drive a (possibly multi-question) AskUserQuestion. Verified TUI semantics
 * (see pty-backend.md "multi-question" capture):
 *
 *   - Multiple questions render as TABS: `← ☐ Q0 ☐ Q1 ✔ Submit →`. The body
 *     shows ONLY the focused tab's question + options, so we discriminate the
 *     active tab by its first option label (the header sits in the always-on
 *     tab bar and can't tell us which tab is focused).
 *   - A SINGLE-SELECT question: pressing the digit selects AND auto-advances to
 *     the next tab (or, for the last question, to the review screen). For a lone
 *     single-select question it submits outright (no review screen).
 *   - A MULTISELECT question: pressing each digit only TOGGLES its checkbox;
 *     it never advances. A single right-arrow (`\x1b[C`) then advances one tab.
 *   - After the last question the TUI shows `Review your answers … ❯ 1. Submit
 *     answers`. Enter confirms (the default). We do this ONCE, at the end —
 *     never inside a per-question step (which would submit prematurely while
 *     later questions are still unanswered).
 */
async function answerQuestions(
  session: PtyClaudeSession,
  answers: Record<string, string>,
  questions: PtyParsedQuestion[],
  logger: Logger,
): Promise<void> {
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const answer = (answers[q.header] ?? answers[q.question] ?? '').trim();

    // Discriminate the active tab by the focused question's first option label.
    // It appears only in the body of THIS question's tab — unlike the header,
    // which is always present in the tab bar — so it tells us the tab actually
    // advanced before we act (avoids typing into a stale/previous frame).
    const marker = q.options[0] || q.header || '';
    const ready = await waitForScreen(
      session,
      (t) => {
        const s = squish(t);
        return s.includes('entertoselect') && (marker === '' || s.includes(squish(marker)));
      },
      MENU_WAIT_MS,
    );
    if (!ready) {
      logger.warn({ qIndex: i, header: q.header }, 'pty-driver: AskUserQuestion menu never rendered');
      return;
    }
    await sleep(250);

    if (q.multiSelect) {
      // Toggles each wanted option, then right-arrow to advance ONE tab.
      await answerMultiSelect(session, q, answer, logger);
    } else {
      const idx = matchOptionIndex(q.options, answer);
      if (idx >= 0) {
        const digit = String(idx + 1); // menu is 1-based
        logger.info({ header: q.header, digit, answer }, 'pty-driver: selecting AskUserQuestion option');
        session.sendKeys(digit); // selects AND auto-advances one tab
      } else {
        await answerFreeText(session, q, answer, logger); // type + Enter advances
      }
    }
    // Let the TUI advance to the next tab / the review screen.
    await sleep(700);
  }

  // Final submit. A lone single-select question already submitted on its digit
  // (no review screen), so skip it. Any other shape — 2+ questions, or any
  // multiSelect — lands on the review screen and needs a confirming Enter.
  const needsReviewSubmit = questions.length > 1 || questions.some((q) => q.multiSelect);
  if (!needsReviewSubmit) return;

  const review = await waitForScreen(
    session,
    (t) => {
      const s = squish(t);
      return s.includes('submitanswers') || s.includes('reviewyouranswers') || s.includes('readytosubmit');
    },
    REVIEW_WAIT_MS,
  );
  if (!review) {
    logger.warn('pty-driver: AskUserQuestion review/submit screen never appeared');
    return;
  }
  await sleep(300);
  logger.info('pty-driver: confirming AskUserQuestion (Submit answers)');
  session.sendKeys('\r'); // "Submit answers" is the focused default
}

/** Use the "Type something" free-text option: digit → type text → Enter. */
async function answerFreeText(
  session: PtyClaudeSession,
  q: PtyParsedQuestion,
  text: string,
  logger: Logger,
): Promise<void> {
  // "Type something" sits immediately after the real options → 1-based digit.
  const digit = String(q.options.length + 1);
  logger.info({ header: q.header, digit, text }, 'pty-driver: free-text answer');
  session.sendKeys(digit);
  await sleep(700); // wait for the input box to open
  for (const ch of text) session.sendKeys(ch);
  await sleep(400);
  session.sendKeys('\r');
}

/**
 * Answer ONE multiSelect (checkbox) question, then advance one tab. Verified
 * flow (see pty-backend.md):
 *   - Each option line is `N.[ ] <label>`; pressing the DIGIT N TOGGLES the
 *     checkbox (it does NOT submit OR advance, unlike single-select).
 *   - A single right-arrow (`\x1b[C`) then advances ONE tab — to the next
 *     question, or to the Submit/Review tab if this was the last question.
 *
 * The final Submit-answers confirmation is handled ONCE by answerQuestions
 * after every question is answered — NOT here — so that a multiSelect that is
 * not the last question doesn't submit prematurely.
 *
 * The answer string is the comma-joined selected labels (e.g. "Cats, Birds"),
 * matching how the SDK/Feishu resolver hands back a multiSelect answer and how
 * the tool_result renders it. We split on commas and toggle each matched option.
 * Falls back to free-text if nothing matches (so claude still gets the string).
 */
async function answerMultiSelect(
  session: PtyClaudeSession,
  q: PtyParsedQuestion,
  answer: string,
  logger: Logger,
): Promise<void> {
  const wanted = answer
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const toggled: number[] = [];
  for (const w of wanted) {
    const idx = matchOptionIndex(q.options, w);
    if (idx < 0) {
      logger.warn({ header: q.header, label: w }, 'pty-driver: multiSelect option not matched');
      continue;
    }
    if (toggled.includes(idx)) continue; // already on — avoid toggling back off
    const digit = String(idx + 1); // menu is 1-based
    logger.info({ header: q.header, digit, label: q.options[idx] }, 'pty-driver: toggling multiSelect option');
    session.sendKeys(digit);
    toggled.push(idx);
    await sleep(350);
  }
  if (toggled.length === 0) {
    logger.warn({ header: q.header }, 'pty-driver: no multiSelect options matched — free-text fallback');
    await answerFreeText(session, q, answer, logger);
    return;
  }
  // multiSelect never auto-advances — right-arrow moves to the next tab.
  logger.info({ header: q.header, toggled }, 'pty-driver: advancing past multiSelect (→ next tab)');
  session.sendKeys('\x1b[C');
}

/** Case-insensitive, whitespace-insensitive option match. -1 if no match. */
export function matchOptionIndex(options: string[], answer: string): number {
  if (!answer) return -1;
  const a = squish(answer);
  for (let i = 0; i < options.length; i++) {
    if (squish(options[i]) === a) return i;
  }
  // Looser: option label contained in the answer or vice-versa.
  for (let i = 0; i < options.length; i++) {
    const o = squish(options[i]);
    if (o && (a.includes(o) || o.includes(a))) return i;
  }
  return -1;
}

/** Lowercase + strip all whitespace (the ANSI strip glues words together). */
function squish(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '');
}

/**
 * Detect the ExitPlanMode approval menu on a (raw) screen tail.
 *
 * The menu TITLE varies by claude version ("Ready to code?" in 2.1.x,
 * "Would you like to proceed?" earlier), so we key off the stable, plan-menu-
 * specific OPTION text "No, keep planning" combined with one of the "Yes"
 * proceed options. That pairing never appears in plan body text or other
 * permission menus, so it's a false-positive-safe signal. Exported + reused by
 * both the driver and the pty-query screen watcher so they agree on one signal.
 */
export function isExitPlanMenu(tail: string): boolean {
  const s = squish(tail);
  if (!s.includes('keepplanning')) return false;
  return (
    s.includes('auto-acceptedits') ||
    s.includes('manuallyapproveedits') ||
    s.includes('bypasspermissions') ||
    s.includes('readytocode') ||
    s.includes('wouldyouliketoproceed')
  );
}
