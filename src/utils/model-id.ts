/**
 * Model identifier helpers shared by the Claude engine and the card renderers.
 *
 * Claude Code accepts a local-only bracket suffix on a model id — today just
 * `[1m]`, which opts into the 1M context beta. The suffix is consumed by the
 * CLI when it spawns; it is NOT part of the model id the API echoes back on
 * assistant records. So the *configured* model (`claude-opus-4-8[1m]`) and the
 * *runtime* model (`claude-opus-4-8`) legitimately differ for the same model,
 * and anything comparing the two — or deriving a context window from one —
 * has to account for the suffix.
 *
 * Keeping the policy in one place so `apply1MContextSettings()` (which decides
 * what to spawn with) and the display path (which reports what was spawned)
 * cannot drift apart.
 */

/** Standard context window, in tokens. */
export const CONTEXT_WINDOW_200K = 200_000;

/** Extended context window granted by the `context-1m-2025-08-07` beta. */
export const CONTEXT_WINDOW_1M = 1_000_000;

/**
 * Models with a native 1M window in Claude Code — no `[1m]` opt-in needed and
 * no env overrides applied. Matches the bare id or one carrying a suffix.
 */
export const FABLE_5_MODEL_RE = /^claude-fable-5(?:$|\[)/;

/** Trailing local-only suffix on a model id, e.g. the `[1m]` in `claude-opus-4-8[1m]`. */
const MODEL_SUFFIX_RE = /\[[^\]]*\]$/;

/**
 * Drop the local-only bracket suffix from a model id.
 *
 * `claude-opus-4-8[1m]` → `claude-opus-4-8`; ids without a suffix pass through.
 * Use before comparing a configured model id against a runtime one.
 */
export function stripModelSuffix(model: string): string {
  return model.replace(MODEL_SUFFIX_RE, '');
}

/** Whether `model` requests the 1M context window (natively or via `[1m]`). */
export function has1MContext(model: string | undefined): boolean {
  if (!model) return false;
  return FABLE_5_MODEL_RE.test(model) || model.includes('[1m]');
}

/**
 * Context window implied by a *configured* model id.
 *
 * This reports the window that was **requested at spawn time**, which is the
 * best signal available on the PTY path: an interactive session emits no
 * `result` record, so the CLI never tells us the window the API actually
 * granted. On auth that doesn't grant the 1M tier (some proxies), a `[1m]`
 * model still runs at 200K and this will over-report. Prefer a window observed
 * off a real `result` message whenever one exists.
 */
export function resolveContextWindow(model: string | undefined): number {
  return has1MContext(model) ? CONTEXT_WINDOW_1M : CONTEXT_WINDOW_200K;
}
