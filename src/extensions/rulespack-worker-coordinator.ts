import type { ExecutionCapabilityService } from '../services/execution-capabilities.js';

export type CoordinatedRulesPackMode = 'off' | 'shadow' | 'enforce';

export interface WorkerRulesPackCoordinationStatus {
  botName: string;
  state: 'configured' | 'unconfigured' | 'opted-out' | 'unsupported' | 'standalone-shared';
  botScoped: boolean;
  mode: CoordinatedRulesPackMode;
  configuredMode?: CoordinatedRulesPackMode;
  operatorModeOverride?: {
    mode: CoordinatedRulesPackMode;
    updatedAt: string;
  };
  operatorModeVersion: number;
  operatorModeOperationId?: string;
  appliesTo: 'subsequent-codex-policy-preparations';
  inFlight: 'unchanged';
}

export interface RulesPackWorkerCoordinator {
  status(botName: string): Promise<WorkerRulesPackCoordinationStatus>;
  setMode(
    botName: string,
    mode: CoordinatedRulesPackMode | null,
    expectedVersion: number,
    operationId: string,
  ): Promise<WorkerRulesPackCoordinationStatus>;
}

export class RulesPackWorkerCoordinationError extends Error {
  constructor(
    message: string,
    readonly code: 'WORKER_UNAVAILABLE' | 'WORKER_REJECTED' | 'INVALID_RESPONSE',
  ) {
    super(message);
    this.name = 'RulesPackWorkerCoordinationError';
  }
}

/**
 * Bridge-side client for the Worker daemon's bot-scoped RulesPack operator.
 * The short-lived lifecycle capability stays on the host-to-host HTTP hop and
 * is never materialized into an engine child environment.
 */
export class LocalRulesPackWorkerCoordinator implements RulesPackWorkerCoordinator {
  private readonly endpoint: URL;
  private readonly timeoutMs: number;

  constructor(options: {
    capabilityService: ExecutionCapabilityService;
    endpoint?: string;
    timeoutMs?: number;
  }) {
    this.capabilityService = options.capabilityService;
    this.endpoint = requireLoopbackEndpoint(options.endpoint ?? 'http://127.0.0.1:9311/mcp');
    this.timeoutMs = options.timeoutMs ?? 5_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30_000) {
      throw new Error('Worker RulesPack coordination timeout must be between 1 and 30000ms');
    }
  }

  private readonly capabilityService: ExecutionCapabilityService;

  status(botName: string): Promise<WorkerRulesPackCoordinationStatus> {
    return this.request(botName, 'status', 'GET');
  }

  async setMode(
    botName: string,
    mode: CoordinatedRulesPackMode | null,
    expectedVersion: number,
    operationId: string,
  ): Promise<WorkerRulesPackCoordinationStatus> {
    const status = await this.request(botName, 'mode', 'PATCH', { mode, expectedVersion, operationId });
    if (!status.botScoped || status.state !== 'configured') {
      throw new RulesPackWorkerCoordinationError(
        `Worker RulesPack bot-scoped control is ${status.state} for ${botName}`,
        'WORKER_REJECTED',
      );
    }
    if (
      status.operatorModeVersion !== expectedVersion + 1 ||
      status.operatorModeOperationId !== operationId
    ) {
      throw new RulesPackWorkerCoordinationError(
        `Worker RulesPack did not acknowledge the expected CAS version for ${botName}`,
        'INVALID_RESPONSE',
      );
    }
    if (mode === null) {
      if (status.operatorModeOverride || status.mode !== status.configuredMode) {
        throw new RulesPackWorkerCoordinationError(
          `Worker RulesPack did not durably clear the mode override for ${botName}`,
          'INVALID_RESPONSE',
        );
      }
    } else if (status.mode !== mode || status.operatorModeOverride?.mode !== mode) {
      throw new RulesPackWorkerCoordinationError(
        `Worker RulesPack did not durably acknowledge mode ${mode} for ${botName}`,
        'INVALID_RESPONSE',
      );
    }
    return status;
  }

  private async request(
    botName: string,
    action: 'status' | 'mode',
    method: 'GET' | 'PATCH',
    body?: Record<string, unknown>,
  ): Promise<WorkerRulesPackCoordinationStatus> {
    const url = new URL(this.endpoint);
    url.pathname = `${url.pathname.replace(/\/+$/u, '')}/rulespack/bots/${encodeURIComponent(botName)}/${action}`;
    let response: Response;
    try {
      const capability = this.capabilityService.issueLocalLifecycleAdmin('worker');
      response = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${capability}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new RulesPackWorkerCoordinationError(
        `Worker RulesPack coordination is unavailable: ${safeError(error)}`,
        'WORKER_UNAVAILABLE',
      );
    }
    const value = await response.json().catch(() => undefined) as unknown;
    if (!response.ok) {
      throw new RulesPackWorkerCoordinationError(
        `Worker RulesPack coordination was rejected with HTTP ${response.status}: ${responseError(value)}`,
        response.status >= 500 ? 'WORKER_UNAVAILABLE' : 'WORKER_REJECTED',
      );
    }
    return validateStatus(value, botName);
  }
}

function requireLoopbackEndpoint(value: string): URL {
  const endpoint = new URL(value);
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(endpoint.hostname)) {
    throw new Error('Worker RulesPack endpoint must use loopback HTTP');
  }
  if (!endpoint.port || !endpoint.pathname || endpoint.pathname === '/') {
    throw new Error('Worker RulesPack endpoint must include a port and dedicated path');
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('Worker RulesPack endpoint must not contain credentials, query, or fragment');
  }
  return endpoint;
}

function validateStatus(value: unknown, botName: string): WorkerRulesPackCoordinationStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidResponse();
  const status = value as Partial<WorkerRulesPackCoordinationStatus>;
  if (
    status.botName !== botName ||
    !['configured', 'unconfigured', 'opted-out', 'unsupported', 'standalone-shared'].includes(String(status.state)) ||
    typeof status.botScoped !== 'boolean' ||
    !isMode(status.mode) ||
    (status.configuredMode !== undefined && !isMode(status.configuredMode)) ||
    !Number.isSafeInteger(status.operatorModeVersion) ||
    (status.operatorModeVersion as number) < 0 ||
    (status.operatorModeOperationId !== undefined && (
      typeof status.operatorModeOperationId !== 'string' || !status.operatorModeOperationId
    )) ||
    status.appliesTo !== 'subsequent-codex-policy-preparations' ||
    status.inFlight !== 'unchanged'
  ) {
    invalidResponse();
  }
  if (status.operatorModeOverride !== undefined && (
    !isMode(status.operatorModeOverride.mode) ||
    typeof status.operatorModeOverride.updatedAt !== 'string' ||
    !status.operatorModeOverride.updatedAt
  )) {
    invalidResponse();
  }
  return status as WorkerRulesPackCoordinationStatus;
}

function invalidResponse(): never {
  throw new RulesPackWorkerCoordinationError(
    'Worker RulesPack coordination returned an invalid response',
    'INVALID_RESPONSE',
  );
}

function isMode(value: unknown): value is CoordinatedRulesPackMode {
  return value === 'off' || value === 'shadow' || value === 'enforce';
}

function responseError(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'invalid error response';
  const error = (value as { error?: unknown }).error;
  if (typeof error === 'string') return error.slice(0, 500);
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message.slice(0, 500);
  }
  return 'request rejected';
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/Bearer\s+\S+/giu, 'Bearer [REDACTED]').slice(0, 500);
}
