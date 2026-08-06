export type ArcErrorCode =
  | 'artifact_invalid'
  | 'artifact_missing'
  | 'invalid_contract'
  | 'invalid_transition'
  | 'path_outside_project'
  | 'project_root_invalid'
  | 'run_conflict'
  | 'run_not_found'
  | 'runner_failure'
  | 'runner_unconfigured'
  | 'symlink_not_allowed';

export class ArcError extends Error {
  readonly code: ArcErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ArcErrorCode,
    message: string,
    options: { cause?: unknown; details?: Record<string, unknown> } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'ArcError';
    this.code = code;
    this.details = options.details;
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export function asArcError(error: unknown): ArcError {
  if (error instanceof ArcError) return error;
  return new ArcError('runner_failure', error instanceof Error ? error.message : String(error), {
    cause: error,
  });
}
