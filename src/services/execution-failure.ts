import { createHash } from 'node:crypto';

const CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/u;
const SECRET_ASSIGNMENT = /\b(api[_-]?key|authorization|bearer|cookie|secret|token)\b\s*[:=]\s*[^\s,;]+/giu;
const BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu;
const DETERMINISTIC_MESSAGE =
  /\b(unsupported|not supported|incompatible|permission denied|forbidden|invalid (?:policy|schema|configuration)|cannot opt out|required policy)\b/iu;

export interface ExecutionFailureMetadata {
  code: string;
  message: string;
  retryable: boolean;
  fingerprint: string;
}

/** Stable, secret-safe failure used by dispatchers to stop deterministic retry loops. */
export class ExecutionPolicyError extends Error {
  readonly retryable = false;

  constructor(readonly code: string, message: string) {
    super(redactExecutionFailure(message));
    this.name = 'ExecutionPolicyError';
    if (!CODE_PATTERN.test(code)) throw new Error('ExecutionPolicyError code must be a stable uppercase identifier');
  }
}

export function executionFailureMetadata(error: unknown): ExecutionFailureMetadata {
  const record = isRecord(error) ? error : undefined;
  const message = redactExecutionFailure(
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : typeof record?.message === 'string'
          ? record.message
          : 'Execution failed',
  );
  const suppliedCode = typeof record?.code === 'string' && CODE_PATTERN.test(record.code)
    ? record.code
    : undefined;
  const explicitRetryable = typeof record?.retryable === 'boolean' ? record.retryable : undefined;
  const retryable = explicitRetryable ?? !DETERMINISTIC_MESSAGE.test(message);
  const code = suppliedCode ?? (retryable ? 'EXECUTION_FAILED' : 'EXECUTION_INCOMPATIBLE');
  return {
    code,
    message,
    retryable,
    fingerprint: createHash('sha256')
      .update(JSON.stringify({ code, message: normalizeFingerprintMessage(message) }))
      .digest('hex'),
  };
}

export function redactExecutionFailure(value: string): string {
  return stripControls(value
    .replace(BEARER_VALUE, 'Bearer [REDACTED]')
    .replace(SECRET_ASSIGNMENT, (_match, key: string) => `${key}=[REDACTED]`))
    .trim()
    .slice(0, 500) || 'Execution failed';
}

function stripControls(value: string): string {
  return Array.from(value).filter((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
  }).join('');
}

function normalizeFingerprintMessage(message: string): string {
  return message
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/giu, '<id>')
    .replace(/\b\d{4,}\b/gu, '<n>')
    .replace(/\s+/gu, ' ')
    .trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}
