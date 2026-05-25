/**
 * `metabot agents` subcommands.
 *
 *   metabot agents list [--include-hidden]
 *   metabot agents register --url <url> [--bot-name <name>] [--hidden]
 *   metabot agents heartbeat [--bot-name <name>]
 *   metabot agents whoami
 *   metabot agents visible <botName>
 *   metabot agents hide    <botName>
 *   metabot agents talk <peer>[/<bot>] <chatId> "<message>"
 *
 * Wire shapes match `packages/server/src/agents/agent-routes.ts`. Cross-bridge
 * talk uses the caller's own `METABOT_CORE_TOKEN` as the Bearer to the peer
 * bridge `/api/talk`; the bridge verifies it via the central `/api/whoami`
 * endpoint. There is no per-bot talkSecret anymore — visibility in the
 * registry is itself the permission to be addressed.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { parseArgs, print, loadConfig } from '@xvirobotics/cli-core';

const DEFAULT_BUS_URL = 'https://metabot-core.xvirobotics.com';

interface BusConfig {
  url: string;
  token: string;
}

function readTokenFile(): string {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.metabot-core', 'token'), 'utf8');
    return raw.split(/\r?\n/)[0]?.trim() || '';
  } catch {
    return '';
  }
}

function loadBusConfig(): BusConfig {
  const env = process.env;
  const overrideUrl = (env.METABOT_CORE_AGENT_BUS_URL || '').trim();
  if (overrideUrl) {
    const token = (env.METABOT_CORE_TOKEN || '').trim() || readTokenFile();
    if (!token) {
      throw new Error(
        'no token configured — set METABOT_CORE_TOKEN env var, or write the token to ~/.metabot-core/token',
      );
    }
    return { url: overrideUrl.replace(/\/+$/, ''), token };
  }
  const cfg = loadConfig();
  return { url: cfg.url, token: cfg.token };
}

async function busRequest<T = unknown>(
  cfg: BusConfig,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  apiPath: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.token}`,
    Accept: 'application/json',
  };
  let payload: string | undefined;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(cfg.url + apiPath, { method, headers, body: payload });
  const text = await res.text();
  let parsed: unknown = text;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // leave raw
    }
  }
  if (!res.ok) {
    const errMsg =
      typeof parsed === 'object' && parsed && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : String(parsed);
    throw new Error(`metabot-core ${method} ${apiPath} → ${res.status}: ${errMsg}`);
  }
  return parsed as T;
}

interface AgentRow {
  botName: string;
  url: string;
  visible: boolean;
  visibleToOwners?: string[];
  lastSeenAt: string;
}

interface ListResponse {
  agents: AgentRow[];
}

function usage(): string {
  return `metabot agents — central agent registry (the "address book" for peer bots)

Subcommands:
  list [--include-hidden]               List visible agents (admin: --include-hidden shows all)
  register --url <url> [--bot-name <name>] [--hidden]
                                        Register a bot in the registry; --bot-name
                                        lets one credential own many bots (anti-squat
                                        is enforced server-side by ownerCredentialId).
  heartbeat [--bot-name <name>]         Bump last_seen_at. Without --bot-name uses the
                                        caller's credential botName (legacy 1:1 mode).
  whoami                                Show the credential identity behind this token
                                        (botName, role, authSource).
  visible <botName>                     Mark <botName> visible (must own or be admin)
  hide    <botName>                     Mark <botName> hidden  (must own or be admin)
  share   <botName> <ownerName>         Add <ownerName> to <botName>'s per-user allowlist.
                                        Only takes effect when the bot is hidden.
  unshare <botName> <ownerName>         Remove <ownerName> from the allowlist.
  shared  <botName>                     Print <botName>'s current allowlist.
  talk <peer>[/<bot>] <chatId> "<msg>"  Send a message to a peer's bot via its /api/talk.
                                        Auth: this command forwards your own
                                        METABOT_CORE_TOKEN; the peer bridge verifies it
                                        via central /api/whoami.

Env:
  METABOT_CORE_URL              memory + agents URL (default ${DEFAULT_BUS_URL})
  METABOT_CORE_AGENT_BUS_URL    override agents-only base URL (falls back to METABOT_CORE_URL)
  METABOT_CORE_TOKEN            bearer token (or ~/.metabot-core/token)
`;
}

async function cmdList(args: string[]): Promise<void> {
  const { flags } = parseArgs(args);
  const cfg = loadBusConfig();
  const includeHidden = flags['include-hidden'] === true || flags['include-hidden'] === 'true';
  const apiPath = includeHidden ? '/api/agents?includeHidden=1' : '/api/agents';
  const resp = await busRequest<ListResponse>(cfg, 'GET', apiPath);
  print(resp);
}

async function cmdRegister(args: string[]): Promise<void> {
  const { flags } = parseArgs(args);
  const url = typeof flags.url === 'string' ? flags.url : '';
  if (!url) throw new Error('metabot agents register: --url <url> required');
  const body: Record<string, unknown> = { url };
  const botName = typeof flags['bot-name'] === 'string' ? flags['bot-name'].trim() : '';
  if (botName) body.botName = botName;
  body.visible = flags.hidden === true ? false : true;
  const cfg = loadBusConfig();
  const resp = await busRequest(cfg, 'POST', '/api/agents', body);
  print(resp);
}

async function cmdHeartbeat(args: string[]): Promise<void> {
  const { flags } = parseArgs(args);
  const botName = typeof flags['bot-name'] === 'string' ? flags['bot-name'].trim() : '';
  const cfg = loadBusConfig();
  const body = botName ? { botNames: [botName] } : {};
  const resp = await busRequest(cfg, 'POST', '/api/agents/heartbeat', body);
  print(resp);
}

async function cmdWhoami(): Promise<void> {
  const cfg = loadBusConfig();
  const resp = await busRequest(cfg, 'GET', '/api/whoami');
  print(resp);
}

async function cmdSetVisibility(args: string[], visible: boolean): Promise<void> {
  const { positional } = parseArgs(args);
  const botName = positional[0];
  if (!botName) {
    throw new Error(`metabot agents ${visible ? 'visible' : 'hide'}: <botName> required`);
  }
  const cfg = loadBusConfig();
  const resp = await busRequest(
    cfg,
    'PATCH',
    `/api/agents/${encodeURIComponent(botName)}/visibility`,
    { visible },
  );
  print(resp);
}

async function readAllowlist(cfg: BusConfig, botName: string): Promise<string[]> {
  // No dedicated GET endpoint — pull /api/agents and find the row. The list
  // route already includes `visibleToOwners` for rows visible to the caller.
  const list = await busRequest<ListResponse>(cfg, 'GET', '/api/agents');
  const row = (list.agents || []).find((a) => a.botName === botName);
  if (!row) throw new Error(`metabot agents: '${botName}' not found in registry (or not visible to you)`);
  return row.visibleToOwners || [];
}

async function cmdShare(args: string[]): Promise<void> {
  const { positional } = parseArgs(args);
  const botName = positional[0];
  const ownerName = positional[1];
  if (!botName || !ownerName) {
    throw new Error('metabot agents share: <botName> <ownerName> required');
  }
  const cfg = loadBusConfig();
  const current = await readAllowlist(cfg, botName);
  if (current.includes(ownerName)) {
    print({ botName, visibleToOwners: current, unchanged: true });
    return;
  }
  const next = [...current, ownerName];
  const resp = await busRequest(
    cfg, 'PATCH', `/api/agents/${encodeURIComponent(botName)}/visible-to-owners`, { owners: next },
  );
  print(resp);
}

async function cmdUnshare(args: string[]): Promise<void> {
  const { positional } = parseArgs(args);
  const botName = positional[0];
  const ownerName = positional[1];
  if (!botName || !ownerName) {
    throw new Error('metabot agents unshare: <botName> <ownerName> required');
  }
  const cfg = loadBusConfig();
  const current = await readAllowlist(cfg, botName);
  if (!current.includes(ownerName)) {
    print({ botName, visibleToOwners: current, unchanged: true });
    return;
  }
  const next = current.filter((o) => o !== ownerName);
  const resp = await busRequest(
    cfg, 'PATCH', `/api/agents/${encodeURIComponent(botName)}/visible-to-owners`, { owners: next },
  );
  print(resp);
}

async function cmdShared(args: string[]): Promise<void> {
  const { positional } = parseArgs(args);
  const botName = positional[0];
  if (!botName) throw new Error('metabot agents shared: <botName> required');
  const cfg = loadBusConfig();
  const current = await readAllowlist(cfg, botName);
  print({ botName, visibleToOwners: current });
}

async function cmdTalk(args: string[]): Promise<void> {
  const { positional } = parseArgs(args);
  const target = positional[0];
  const chatId = positional[1];
  const content = positional[2];
  if (!target || !chatId || content === undefined) {
    throw new Error('metabot agents talk: <peer>[/<bot>] <chatId> "<message>" required');
  }
  const slash = target.indexOf('/');
  const peerName = slash >= 0 ? target.slice(0, slash) : target;
  const botName = slash >= 0 ? target.slice(slash + 1) : target;
  if (!peerName) throw new Error('metabot agents talk: <peer> empty');
  if (!botName) throw new Error('metabot agents talk: <bot> empty after slash');

  const cfg = loadBusConfig();
  const list = await busRequest<ListResponse>(cfg, 'GET', '/api/agents');
  const peer = (list.agents || []).find((a) => a.botName === peerName);
  if (!peer) {
    throw new Error(
      `metabot agents talk: peer '${peerName}' not in registry — run \`metabot agents list\` to see who's online`,
    );
  }
  if (!peer.url) throw new Error(`metabot agents talk: peer '${peerName}' has no url in registry`);

  const peerUrl = peer.url.replace(/\/+$/, '') + '/api/talk';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-MetaBot-Origin': 'peer',
    Authorization: `Bearer ${cfg.token}`,
  };
  const res = await fetch(peerUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ botName, chatId, content }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`POST ${peerUrl} → ${res.status}: ${text}`);
  }
  process.stdout.write(`→ ${peerName}/${botName} @ ${chatId}\n`);
}

export async function run(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    process.stdout.write(usage());
    return;
  }
  switch (sub) {
    case 'list':
      return cmdList(rest);
    case 'register':
      return cmdRegister(rest);
    case 'heartbeat':
      return cmdHeartbeat(rest);
    case 'whoami':
      return cmdWhoami();
    case 'visible':
    case 'show':
      return cmdSetVisibility(rest, true);
    case 'hide':
      return cmdSetVisibility(rest, false);
    case 'share':
      return cmdShare(rest);
    case 'unshare':
      return cmdUnshare(rest);
    case 'shared':
      return cmdShared(rest);
    case 'talk':
      return cmdTalk(rest);
    default:
      process.stderr.write(`metabot agents: unknown subcommand '${sub}'\n\n`);
      process.stdout.write(usage());
      process.exit(2);
  }
}
