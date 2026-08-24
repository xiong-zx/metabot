import {
  ExecutionCapabilityError,
  ExecutionCapabilityService,
  requiredCapabilityAudience,
  type ExecutionCapabilityPurpose,
  type ExecutionCapabilityRole,
} from './execution-capabilities.js';
import { leaseCapabilityFile, type CapabilityLease } from './capability-lease.js';
import {
  EXECUTION_MCP_SERVERS,
  type AnyMcpServerDescriptor,
} from './mcp-registry.js';

/**
 * Short-lived capability acquisition for standalone Codex and Claude clients.
 *
 * MetaBot-launched sessions get a capability because the Bridge materializes
 * one for the turn it is running. A user who starts `codex` or `claude` in a
 * terminal has no such turn, and the tempting answers are all wrong:
 *
 * - shipping the issuer private key to the client makes every client an issuer;
 * - a long-lived token on disk is a standing grant with no turn to bound it;
 * - an unauthenticated local endpoint is reachable by anything on the host.
 *
 * What is safe is for the issuer process — which already holds the key — to
 * mint a short-lived token and hand back a **path to a leased 0600 file**. The
 * private key never leaves the issuer, the token never enters argv or an
 * environment variable that `ps` can read, and the grant expires on its own.
 *
 * This module is the offline half of that contract: the policy, the TTL bound,
 * the audience requirement, and the lease. It deliberately binds no socket and
 * exposes no route. Peer authentication for a loopback endpoint — same-uid
 * verification, `Host`/`Origin` policy, rate limiting — belongs with the
 * endpoint, and until that lands the issuer stays disabled and fails closed.
 */

export const STANDALONE_CAPABILITY_DEFAULT_TTL_MS = 5 * 60 * 1000;
export const STANDALONE_CAPABILITY_MAX_TTL_MS = 15 * 60 * 1000;

export interface StandaloneIssuerStatus {
  readonly enabled: boolean;
  /** Audiences a standalone client may request, empty while disabled. */
  readonly audiences: readonly string[];
  readonly maxTtlMs: number;
  readonly limitation: string;
}

export interface StandaloneCapabilityRequest {
  purpose: ExecutionCapabilityPurpose;
  role: ExecutionCapabilityRole;
  botName: string;
  chatId: string;
  runtimeRoot: string;
  ttlMs?: number;
}

export interface StandaloneCapabilityGrant {
  /** Path to the leased 0600 file. The token itself is never returned. */
  readonly capabilityFilePath: string;
  readonly audience: string;
  readonly purpose: ExecutionCapabilityPurpose;
  readonly expiresAt: number;
  readonly release: () => void;
}

export interface StandaloneIssuerOptions {
  /**
   * Explicit opt-in. There is no environment-variable default: a standing
   * grant path that a stray variable can switch on is not gated at all.
   */
  enabled?: boolean;
  service?: ExecutionCapabilityService;
  now?: () => number;
}

/**
 * Only audiences on the strict claim contract are eligible. A `v2.1-purpose`
 * server carries no audience claim, so a token minted for one standalone client
 * is indistinguishable from a token minted for anything else that shares its
 * key — precisely the confusion a standalone grant must not introduce.
 */
export function standaloneEligibleAudiences(
  audiences: readonly AnyMcpServerDescriptor[] = EXECUTION_MCP_SERVERS,
): string[] {
  return audiences
    .filter((descriptor) => descriptor.standaloneEligible && descriptor.capabilityContract === 'v3-audience')
    .map((descriptor) => descriptor.audience);
}

export function standaloneIssuerStatus(options: StandaloneIssuerOptions = {}): StandaloneIssuerStatus {
  const enabled = options.enabled === true;
  return {
    enabled,
    audiences: enabled ? standaloneEligibleAudiences() : [],
    maxTtlMs: STANDALONE_CAPABILITY_MAX_TTL_MS,
    limitation: enabled
      ? 'Grants are short-lived leased files; the issuer private key never leaves this process.'
      : 'Standalone capability acquisition is not activated: no authenticated loopback issuer endpoint exists yet (MCPINT-007).',
  };
}

export function issueStandaloneCapabilityLease(
  request: StandaloneCapabilityRequest,
  options: StandaloneIssuerOptions = {},
): StandaloneCapabilityGrant {
  if (options.enabled !== true) {
    throw new ExecutionCapabilityError(
      standaloneIssuerStatus(options).limitation,
      'STANDALONE_ISSUER_DISABLED',
    );
  }
  const audience = requiredCapabilityAudience(request.purpose);
  if (audience === undefined) {
    throw new ExecutionCapabilityError(
      `Purpose ${request.purpose} carries no signed audience; standalone grants require one`,
      'STANDALONE_AUDIENCE_REQUIRED',
    );
  }
  const ttlMs = request.ttlMs ?? STANDALONE_CAPABILITY_DEFAULT_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > STANDALONE_CAPABILITY_MAX_TTL_MS) {
    throw new ExecutionCapabilityError(
      `Standalone capability ttlMs must be between 1 and ${STANDALONE_CAPABILITY_MAX_TTL_MS}`,
      'INVALID_TTL',
    );
  }

  const now = (options.now ?? Date.now)();
  const service = options.service ?? new ExecutionCapabilityService();
  const token = service.issue(
    {
      purpose: request.purpose,
      role: request.role,
      botName: request.botName,
      chatId: request.chatId,
      ttlMs,
    },
    now,
  );

  let lease: CapabilityLease;
  try {
    lease = leaseCapabilityFile({
      runtimeRoot: request.runtimeRoot,
      audience,
      scope: `${request.botName}_${request.chatId}`,
      token,
      expiresAt: now + ttlMs,
    });
  } catch (cause) {
    throw new ExecutionCapabilityError(
      `Unable to lease a standalone capability: ${cause instanceof Error ? cause.message : String(cause)}`,
      'STANDALONE_LEASE_FAILED',
    );
  }

  return {
    capabilityFilePath: lease.path,
    audience,
    purpose: request.purpose,
    expiresAt: lease.expiresAt,
    release: lease.release,
  };
}
