import type { Credential } from '../auth/credentials.js';
import {
  AgentNotFoundError,
  AgentStore,
  NameSquatError,
  type AgentRecord,
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

  try {
    const rec = store.register({
      botName,
      url,
      visible,
      ownerCredentialId: cred.id,
    });
    return { status: 201, body: publicShape(rec) };
  } catch (e) {
    if (e instanceof NameSquatError) return err(403, 'name_squat');
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
  body: Record<string, unknown>,
  cred: Credential,
): RouteResult {
  const bots = Array.isArray(body.bots) ? (body.bots as Array<Record<string, unknown>>) : null;
  if (!bots) return err(400, 'bots_array_required');

  const results: Array<{ botName: string; status: number; error?: string }> = [];
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
    try {
      store.register({ botName, url, visible, ownerCredentialId: cred.id });
      results.push({ botName, status: 201 });
      registered++;
    } catch (e) {
      if (e instanceof NameSquatError) {
        results.push({ botName, status: 403, error: 'name_squat' });
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
// by this value, so callers see "all bots on 172.31.32.2" vs "all bots on
// localhost" rather than a flat list. Falls back to the raw url string when
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
  const agents = store.list({ includeHidden });
  return {
    status: 200,
    body: {
      agents: agents.map((a) => ({
        botName: a.botName,
        url: a.url,
        host: deriveHost(a.url),
        visible: a.visible,
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
