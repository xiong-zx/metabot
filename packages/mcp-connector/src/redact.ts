/**
 * Secret redaction for anything a connector may emit: error messages, stderr
 * diagnostics, status payloads.
 *
 * A connector holds two secrets it did not choose — a leased capability token
 * and a service bearer — and every one of its failure paths stringifies
 * something. Redaction is applied at the boundary rather than trusted to each
 * call site, because the call site that forgets is the one that leaks.
 */
export interface Redactor {
  (value: unknown): string;
  /** Number of distinct secrets currently registered. */
  readonly size: number;
}

const PLACEHOLDER = '[redacted]';

/** Secrets shorter than this are not worth matching and would over-redact. */
const MIN_SECRET_LENGTH = 8;

export function createRedactor(secrets: readonly (string | undefined)[]): Redactor {
  const registered = [...new Set(
    secrets
      .filter((secret): secret is string => typeof secret === 'string' && secret.trim().length >= MIN_SECRET_LENGTH)
      .map((secret) => secret.trim()),
  )].sort((a, b) => b.length - a.length);

  const redact = ((value: unknown): string => {
    let text = stringify(value);
    for (const secret of registered) {
      if (text.includes(secret)) text = text.split(secret).join(PLACEHOLDER);
    }
    return text;
  }) as { (value: unknown): string; size: number };
  Object.defineProperty(redact, 'size', { value: registered.length, enumerable: true });
  return redact as Redactor;
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
