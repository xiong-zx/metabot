export type RulesPackErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNSAFE_RULE_TEXT'
  | 'TARGET_MISMATCH'
  | 'DEPENDENCY_ERROR'
  | 'MANDATORY_BUDGET_EXCEEDED'
  | 'COMPILE_UNAVAILABLE'
  | 'SOURCE_UNAVAILABLE'
  | 'PATH_ESCAPE'
  | 'STORE_ERROR';

export class RulesPackError extends Error {
  readonly code: RulesPackErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: RulesPackErrorCode, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = 'RulesPackError';
    this.code = code;
    this.details = details;
  }
}
