import type { Credential } from '../auth/credentials.js';
import type { CredentialRulesPackIdentity } from '../auth/credentials.js';
import {
  CredentialRulesPackIdentityMismatchError,
  type CredentialsStore,
} from '../auth/credentials-store.js';
import {
  AgentNotFoundError,
  AgentStore,
  NameSquatError,
  RulesPackStatusConflictError,
  type AgentRecord,
  type AgentRulesPackStatus,
} from './agent-store.js';

export interface RouteResult {
  status: number;
  body: unknown;
}

function err(status: number, error: string): RouteResult {
  return { status, body: { error } };
}

function publicShape(rec: AgentRecord) {
  return {
    id: rec.id,
    botName: rec.botName,
    url: rec.url,
    visible: rec.visible,
    memoryPublic: rec.memoryPublic,
    ...(rec.rulesPackStatus ? { rulesPackStatus: rec.rulesPackStatus } : {}),
    ...(rec.rulesPackIdentity ? { rulesPackIdentity: rec.rulesPackIdentity } : {}),
    visibleToOwners: rec.visibleToOwners,
    registeredAt: rec.registeredAt,
    lastSeenAt: rec.lastSeenAt,
  };
}

/**
 * Resolve the botName to register from request body and credential. The body
 * may name a bot different from `cred.botName` — this is what lets one bridge
 * credential register many bots. Anti-squat across credentials is enforced by
 * `AgentStore.register` (UNIQUE bot_name + ownerCredentialId check).
 *
 * Legacy callers that omit `botName` still get `cred.botName` (1:1 mode).
 */
function resolveBotName(body: Record<string, unknown>, cred: Credential): string {
  const raw = typeof body.botName === 'string' ? body.botName.trim() : '';
  return raw || cred.botName;
}

function rulesPackStatus(value: unknown): AgentRulesPackStatus | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('rulespack_status_invalid');
  const status = value as Record<string, unknown>;
  if (!['inherited', 'overridden', 'opted-out', 'unconfigured', 'unsupported'].includes(String(status.state))) {
    throw new Error('rulespack_status_invalid');
  }
  if (typeof status.required !== 'boolean') throw new Error('rulespack_status_invalid');
  if (status.mode !== undefined && !['off', 'shadow', 'enforce'].includes(String(status.mode))) {
    throw new Error('rulespack_status_invalid');
  }
  if (
    status.operatorModeVersion !== undefined &&
    (!Number.isSafeInteger(status.operatorModeVersion) || (status.operatorModeVersion as number) < 0)
  ) {
    throw new Error('rulespack_status_invalid');
  }
  if (
    status.operatorModeOperationId !== undefined &&
    (typeof status.operatorModeOperationId !== 'string' || !status.operatorModeOperationId.trim() ||
      status.operatorModeOperationId.length > 500)
  ) {
    throw new Error('rulespack_status_invalid');
  }
  const hasOperatorModeOperation = status.operatorModeOperationId !== undefined;
  if (
    (status.operatorModeVersion === undefined && hasOperatorModeOperation) ||
    (status.operatorModeVersion === 0 && hasOperatorModeOperation) ||
    (typeof status.operatorModeVersion === 'number' && status.operatorModeVersion > 0 && !hasOperatorModeOperation)
  ) {
    throw new Error('rulespack_status_invalid');
  }
  if (
    status.defaultProjectId !== undefined &&
    status.defaultProjectId !== null &&
    (
      typeof status.defaultProjectId !== 'string' ||
      !status.defaultProjectId.trim() ||
      status.defaultProjectId !== status.defaultProjectId.trim() ||
      status.defaultProjectId.length > 500
    )
  ) {
    throw new Error('rulespack_status_invalid');
  }
  const projectChatAttestations = rulesPackProjectChatAttestations(status.projectChatAttestations);
  if (status.optOutReason !== undefined && typeof status.optOutReason !== 'string') {
    throw new Error('rulespack_status_invalid');
  }
  return {
    state: status.state as AgentRulesPackStatus['state'],
    required: status.required,
    ...(status.mode !== undefined ? { mode: status.mode as NonNullable<AgentRulesPackStatus['mode']> } : {}),
    ...(status.operatorModeVersion !== undefined
      ? { operatorModeVersion: status.operatorModeVersion as number }
      : {}),
    ...(status.operatorModeOperationId !== undefined
      ? { operatorModeOperationId: status.operatorModeOperationId as string }
      : {}),
    ...(status.defaultProjectId !== undefined
      ? { defaultProjectId: status.defaultProjectId as string | null }
      : {}),
    ...(projectChatAttestations ? { projectChatAttestations } : {}),
    ...(status.optOutReason !== undefined ? { optOutReason: status.optOutReason as string } : {}),
  };
}

function rulesPackProjectChatAttestations(
  value: unknown,
): AgentRulesPackStatus['projectChatAttestations'] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 4_096) throw new Error('rulespack_status_invalid');
  const seen = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('rulespack_status_invalid');
    const entry = item as Record<string, unknown>;
    if (Object.keys(entry).sort().join(',') !== 'projectId,subjectKey') {
      throw new Error('rulespack_status_invalid');
    }
    if (typeof entry.subjectKey !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(entry.subjectKey)) {
      throw new Error('rulespack_status_invalid');
    }
    if (
      typeof entry.projectId !== 'string' ||
      !entry.projectId.trim() ||
      entry.projectId !== entry.projectId.trim() ||
      entry.projectId.length > 500
    ) {
      throw new Error('rulespack_status_invalid');
    }
    if (seen.has(entry.subjectKey)) throw new Error('rulespack_status_invalid');
    seen.add(entry.subjectKey);
    return { subjectKey: entry.subjectKey, projectId: entry.projectId };
  });
}

const RULESPACK_HOST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/u;

function rulesPackIdentity(value: unknown): CredentialRulesPackIdentity | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('rulespack_identity_invalid');
  }
  const identity = value as Record<string, unknown>;
  const keys = Object.keys(identity).sort();
  if (keys.length !== 2 || keys[0] !== 'audience' || keys[1] !== 'hostId') {
    throw new Error('rulespack_identity_invalid');
  }
  if (
    typeof identity.hostId !== 'string' ||
    !RULESPACK_HOST_ID_PATTERN.test(identity.hostId) ||
    typeof identity.audience !== 'string' ||
    !identity.audience.trim() ||
    identity.audience !== identity.audience.trim() ||
    identity.audience.length > 500
  ) {
    throw new Error('rulespack_identity_invalid');
  }
  return { hostId: identity.hostId, audience: identity.audience };
}

function activeRulesPack(status: AgentRulesPackStatus | undefined): boolean {
  return Boolean(
    status &&
    (status.state === 'inherited' || status.state === 'overridden') &&
    (status.mode === 'shadow' || status.mode === 'enforce'),
  );
}

export function registerAgent(
  store: AgentStore,
  body: Record<string, unknown>,
  cred: Credential,
): RouteResult {
  const url = typeof body.url === 'string' ? body.url : '';
  if (!url) return err(400, 'url_required');
  const botName = resolveBotName(body, cred);
  if (!botName) return err(400, 'bot_name_required');
  const visible = body.visible === undefined ? true : !!body.visible;
  const memoryPublic = body.memoryPublic === undefined ? undefined : !!body.memoryPublic;
  let resolvedRulesPackStatus: AgentRulesPackStatus | undefined;
  try {
    resolvedRulesPackStatus = rulesPackStatus(body.rulesPackStatus);
  } catch {
    return err(400, 'rulespack_status_invalid');
  }

  try {
    if (activeRulesPack(resolvedRulesPackStatus) && !cred.rulesPackIdentity) {
      return err(409, 'rulespack_identity_required');
    }
    if (cred.rulesPackIdentity) {
      store.stampRulesPackIdentityForOwner(cred.id, cred.rulesPackIdentity);
    }
    const rec = store.register({
      botName,
      url,
      visible,
      memoryPublic,
      rulesPackStatus: resolvedRulesPackStatus,
      rulesPackIdentity: cred.rulesPackIdentity,
      ownerCredentialId: cred.id,
      ownerName: cred.ownerName,
    });
    return { status: 201, body: publicShape(rec) };
  } catch (e) {
    if (e instanceof NameSquatError) return err(403, 'name_squat');
    if (e instanceof RulesPackStatusConflictError) return err(409, 'rulespack_status_stale');
    throw e;
  }
}

/**
 * Batch-register every entry in `body.bots`. Each entry has the same shape as
 * a single register call (`{botName, url, visible?}`). Returns a result list
 * with per-entry status — partial success is allowed (e.g. one name squat
 * doesn't fail the whole batch).
 *
 * Used by the bridge to register all visible bots from `bots.json` in one
 * RPC at boot.
 */
export function registerAgentsBulk(
  store: AgentStore,
  credentials: CredentialsStore,
  body: Record<string, unknown>,
  cred: Credential,
): RouteResult {
  const bots = Array.isArray(body.bots) ? (body.bots as Array<Record<string, unknown>>) : null;
  if (!bots) return err(400, 'bots_array_required');

  let proposedIdentity: CredentialRulesPackIdentity | undefined;
  try {
    proposedIdentity = rulesPackIdentity(body.rulesPackIdentity);
  } catch {
    return err(400, 'rulespack_identity_invalid');
  }
  let authenticatedIdentity = cred.rulesPackIdentity;
  if (proposedIdentity) {
    try {
      authenticatedIdentity = credentials.bindRulesPackIdentity(cred.id, proposedIdentity).rulesPackIdentity;
    } catch (error) {
      if (error instanceof CredentialRulesPackIdentityMismatchError) {
        return err(409, 'rulespack_identity_mismatch');
      }
      throw error;
    }
  }

  const containsActiveRulesPack = bots.some((entry) => {
    try {
      return activeRulesPack(rulesPackStatus(entry.rulesPackStatus));
    } catch {
      return false;
    }
  });
  if (containsActiveRulesPack && !authenticatedIdentity) {
    return err(409, 'rulespack_identity_required');
  }
  if (authenticatedIdentity) {
    store.stampRulesPackIdentityForOwner(cred.id, authenticatedIdentity);
  }

  const results: Array<{
    botName: string;
    status: number;
    error?: string;
    rulesPackIdentity?: CredentialRulesPackIdentity;
  }> = [];
  let registered = 0;
  for (const entry of bots) {
    const url = typeof entry.url === 'string' ? entry.url : '';
    const botName = resolveBotName(entry, cred);
    if (!url) {
      results.push({ botName, status: 400, error: 'url_required' });
      continue;
    }
    if (!botName) {
      results.push({ botName: '', status: 400, error: 'bot_name_required' });
      continue;
    }
    const visible = entry.visible === undefined ? true : !!entry.visible;
    const memoryPublic = entry.memoryPublic === undefined ? undefined : !!entry.memoryPublic;
    let resolvedRulesPackStatus: AgentRulesPackStatus | undefined;
    try {
      resolvedRulesPackStatus = rulesPackStatus(entry.rulesPackStatus);
    } catch {
      results.push({ botName, status: 400, error: 'rulespack_status_invalid' });
      continue;
    }
    try {
      store.register({
        botName, url, visible, memoryPublic, rulesPackStatus: resolvedRulesPackStatus,
        rulesPackIdentity: authenticatedIdentity,
        ownerCredentialId: cred.id,
        ownerName: cred.ownerName,
      });
      results.push({
        botName,
        status: 201,
        ...(authenticatedIdentity ? { rulesPackIdentity: authenticatedIdentity } : {}),
      });
      registered++;
    } catch (e) {
      if (e instanceof NameSquatError) {
        results.push({ botName, status: 403, error: 'name_squat' });
      } else if (e instanceof RulesPackStatusConflictError) {
        results.push({ botName, status: 409, error: 'rulespack_status_stale' });
      } else {
        throw e;
      }
    }
  }
  return { status: 200, body: { registered, results } };
}

export function heartbeat(
  store: AgentStore,
  body: Record<string, unknown>,
  cred: Credential,
): RouteResult {
  // Batch form: { botNames: ["a", "b", ...] } — bumps every owned name.
  if (Array.isArray(body.botNames)) {
    const names = (body.botNames as unknown[]).filter((n): n is string => typeof n === 'string');
    const bumped = store.heartbeatMany(names, cred.id);
    return { status: 200, body: { ok: true, bumped } };
  }
  // Legacy single form: cred.botName is the target.
  try {
    const lastSeenAt = store.heartbeat(cred.botName, cred.id);
    return { status: 200, body: { ok: true, lastSeenAt } };
  } catch (e) {
    if (e instanceof AgentNotFoundError) return err(404, 'agent_not_registered');
    if (e instanceof NameSquatError) return err(403, 'name_squat');
    throw e;
  }
}

// Derive the host the agent advertises itself on. The web UI groups agents
// by this value, so callers see "all bots on host-a.example.com" vs "all bots
// on localhost" rather than a flat list. Falls back to the raw url string when
// parsing throws (malformed URL stored against expectation) so the list call
// never 500s on a single bad row.
function deriveHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function listAgents(
  store: AgentStore,
  query: URLSearchParams,
  cred: Credential,
): RouteResult {
  const includeHidden = query.get('includeHidden') === '1';
  if (includeHidden && cred.role !== 'admin') {
    return err(403, 'include_hidden_admin_only');
  }
  // Always pull every row, then filter in JS — the owner-bypass needs
  // hidden rows owned by `cred.ownerName` to come back even when the caller
  // is a member. The legacy `visible = 1` SQL pre-filter at the store level
  // would have hidden the caller's own bots from their other-machine cred.
  const all = store.list({ includeHidden: true });
  const visibleToCaller = (a: { visible: boolean; ownerName: string; visibleToOwners: string[] }): boolean => {
    if (includeHidden) return true; // admin-only, already gated above
    if (cred.role === 'admin') return true;
    if (a.visible) return true;
    if (!cred.ownerName) return false;
    if (a.ownerName === cred.ownerName) return true;
    // Per-user allowlist — owner-side opt-in. Only consulted when the bot
    // is hidden (`visible=false`) so it never *narrows* a public bot.
    return a.visibleToOwners.includes(cred.ownerName);
  };
  const agents = all.filter(visibleToCaller);
  return {
    status: 200,
    body: {
      agents: agents.map((a) => ({
        botName: a.botName,
        url: a.url,
        host: deriveHost(a.url),
        visible: a.visible,
        ownerName: a.ownerName,
        memoryPublic: a.memoryPublic,
        ...(a.rulesPackStatus ? { rulesPackStatus: a.rulesPackStatus } : {}),
        ...(a.rulesPackIdentity ? { rulesPackIdentity: a.rulesPackIdentity } : {}),
        visibleToOwners: a.visibleToOwners,
        lastSeenAt: a.lastSeenAt,
      })),
    },
  };
}

export function setAgentVisibility(
  store: AgentStore,
  botName: string,
  body: Record<string, unknown>,
  cred: Credential,
): RouteResult {
  if (typeof body.visible !== 'boolean') {
    return err(400, 'visible_required');
  }
  const existing = store.getByName(botName);
  if (!existing) return err(404, 'agent_not_found');
  if (existing.ownerCredentialId !== cred.id && cred.role !== 'admin') {
    return err(403, 'agent_ownership_required');
  }
  const rec = store.setVisibility(botName, body.visible);
  return { status: 200, body: { botName: rec.botName, visible: rec.visible } };
}

/**
 * PATCH /api/agents/:botName/visible-to-owners — replace the per-user
 * allowlist with the supplied array. Body `{ owners: string[] }`. Owner-
 * credential or admin only. Empty array clears the allowlist.
 *
 * Pairs with `visible:false`: setting an allowlist on a `visible:true` bot
 * is allowed but has no effect — a public bot is visible to everyone.
 */
export function setAgentVisibleToOwners(
  store: AgentStore,
  botName: string,
  body: Record<string, unknown>,
  cred: Credential,
): RouteResult {
  const raw = body.owners;
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string')) {
    return err(400, 'owners_required');
  }
  const owners = (raw as string[]).map((s) => s.trim()).filter(Boolean);
  // De-dup while preserving caller-supplied order.
  const seen = new Set<string>();
  const deduped = owners.filter((o) => (seen.has(o) ? false : (seen.add(o), true)));
  const existing = store.getByName(botName);
  if (!existing) return err(404, 'agent_not_found');
  if (existing.ownerCredentialId !== cred.id && cred.role !== 'admin') {
    return err(403, 'agent_ownership_required');
  }
  const rec = store.setVisibleToOwners(botName, deduped);
  return { status: 200, body: { botName: rec.botName, visibleToOwners: rec.visibleToOwners } };
}

/**
 * PATCH /api/agents/:botName/memory-visibility — toggle whether `metabot
 * memory create/mkdir` auto-prefixes this bot's writes into `/shared/` (true)
 * or `/users/` (false). Owner-credential or admin only.
 *
 * This does NOT move existing documents — toggling only changes the default
 * write target. To make an old private doc public, the owner moves it via
 * `metabot memory move`.
 */
export function setAgentMemoryPublic(
  store: AgentStore,
  botName: string,
  body: Record<string, unknown>,
  cred: Credential,
): RouteResult {
  if (typeof body.memoryPublic !== 'boolean') {
    return err(400, 'memory_public_required');
  }
  const existing = store.getByName(botName);
  if (!existing) return err(404, 'agent_not_found');
  if (existing.ownerCredentialId !== cred.id && cred.role !== 'admin') {
    return err(403, 'agent_ownership_required');
  }
  const rec = store.setMemoryPublic(botName, body.memoryPublic);
  return { status: 200, body: { botName: rec.botName, memoryPublic: rec.memoryPublic } };
}

export function removeAgent(
  store: AgentStore,
  botName: string,
  cred: Credential,
): RouteResult {
  const existing = store.getByName(botName);
  if (!existing) return err(404, 'agent_not_found');
  if (existing.ownerCredentialId !== cred.id && cred.role !== 'admin') {
    return err(403, 'agent_ownership_required');
  }
  const removed = store.remove(botName);
  if (!removed) return err(404, 'agent_not_found');
  return { status: 200, body: { botName, removed: true } };
}
