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
 * Wire shapes match `packages/server/src/agents/agent-routes.ts`. Cross-agent
 * talk from the CLI always enqueues through metabot-core's inbox relay. Resident
 * bridges still route same-bridge local bots directly before peer lookup; the
 * CLI has no local bridge registry, so it should not attempt direct P2P based on
 * registry URLs.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { parseArgs, print, loadConfig } from '@xvirobotics/cli-core';
import { deriveProjectChatId } from './project-id.js';

// Personal edition default: local metabot-core. Override with METABOT_CORE_URL.
const DEFAULT_BUS_URL = 'http://localhost:9200';

interface BusConfig {
  url: string;
  token: string;
}

interface EngineTalkConfig {
  url: string;
  capability: string;
  botName: string;
  chatId: string;
}

interface AgentTalkReceipt {
  taskId: string;
  requestId: string;
  status: 'accepted';
  targetBot: string;
  targetChatId: string;
  cardMessageId?: string;
  deliveryState: 'pending' | 'running' | 'error';
  message: string;
}

interface AgentTalkStatusReceipt {
  taskId: string;
  status: 'accepted' | 'running' | 'completed' | 'failed';
  botName: string;
  chatId: string;
  sourceBot: string;
  sourceChatId: string;
  targetBot: string;
  targetChatId: string;
  cardMessageId?: string;
  deliveryState: 'accepted' | 'pending' | 'running' | 'complete' | 'error';
  createdAt: string;
  completedAt?: string;
  result?: { success: boolean; [key: string]: unknown };
}

const TEAM_CAPABILITY_HEADER = 'x-metabot-team-capability';
const TEAM_BOT_HEADER = 'x-metabot-bot-name';
const TEAM_CHAT_HEADER = 'x-metabot-chat-id';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function loadEngineTalkConfig(env: NodeJS.ProcessEnv = process.env): EngineTalkConfig | undefined {
  const values = {
    url: (env.METABOT_ENGINE_BRIDGE_URL || '').trim(),
    capability: (env.METABOT_TEAM_CAPABILITY || '').trim(),
    botName: (env.METABOT_BOT_NAME || '').trim(),
    chatId: (env.METABOT_CHAT_ID || env.METABOT_CHAT || '').trim(),
  };
  if (!Object.values(values).some(Boolean)) return undefined;
  if (!Object.values(values).every(Boolean)) {
    throw new Error('metabot agents talk: incomplete signed engine-session routing context');
  }
  const parsed = new URL(values.url);
  if (parsed.protocol !== 'http:' || !isLoopbackHost(parsed.hostname)) {
    throw new Error('metabot agents talk: METABOT_ENGINE_BRIDGE_URL must be loopback HTTP');
  }
  return values;
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isIsoTimestamp(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  const milliseconds = Date.parse(value);
  return !Number.isNaN(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOptionalNonNegativeNumber(value: unknown): boolean {
  return value === undefined
    || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

function isRulesPackDelivery(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  const allowed = new Set(['status', 'envelopeId', 'replayId', 'packDigest', 'effectivePackDigest']);
  return Object.keys(value).every((key) => allowed.has(key))
    && (value.status === 'shadowed' || value.status === 'consumed')
    && isNonEmptyString(value.envelopeId)
    && isNonEmptyString(value.replayId)
    && isNonEmptyString(value.packDigest)
    && isNonEmptyString(value.effectivePackDigest);
}

function isTerminalResult(value: unknown, status: 'completed' | 'failed'): boolean {
  if (!isRecord(value)) return false;
  const allowed = new Set(['success', 'responseText', 'costUsd', 'durationMs', 'error', 'rulesPackDelivery']);
  const success = status === 'completed';
  return Object.keys(value).every((key) => allowed.has(key))
    && value.success === success
    && typeof value.responseText === 'string'
    && isOptionalNonNegativeNumber(value.costUsd)
    && isOptionalNonNegativeNumber(value.durationMs)
    && isRulesPackDelivery(value.rulesPackDelivery)
    && (success ? value.error === undefined : isNonEmptyString(value.error));
}

async function parseBridgeResponse(response: Response, operation: string): Promise<unknown> {
  const text = await response.text();
  let parsed: unknown = text;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // leave raw
    }
  }
  if (!response.ok) {
    const message = typeof parsed === 'object' && parsed && 'error' in parsed
      ? String((parsed as { error: unknown }).error)
      : String(parsed);
    throw new Error(`resident Bridge ${operation} → ${response.status}: ${message}`);
  }
  return parsed;
}

function engineTalkHeaders(config: EngineTalkConfig): Record<string, string> {
  return {
    Authorization: 'Bearer execution-capability',
    Accept: 'application/json',
    [TEAM_CAPABILITY_HEADER]: config.capability,
    [TEAM_BOT_HEADER]: config.botName,
    [TEAM_CHAT_HEADER]: config.chatId,
  };
}

async function bridgeTalkRequest(
  config: EngineTalkConfig,
  body: { botName: string; chatId: string; prompt: string },
): Promise<AgentTalkReceipt> {
  const response = await fetch(`${config.url.replace(/\/+$/, '')}/api/talk`, {
    method: 'POST',
    headers: { ...engineTalkHeaders(config), 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, async: true, sendCards: true }),
  });
  const parsed = await parseBridgeResponse(response, 'POST /api/talk');
  if (!isRecord(parsed)) {
    throw new Error('resident Bridge returned an invalid Agent Bus talk receipt');
  }
  const receipt = parsed as Partial<AgentTalkReceipt>;
  const allowed = new Set([
    'taskId', 'requestId', 'status', 'targetBot', 'targetChatId',
    'cardMessageId', 'deliveryState', 'message',
  ]);
  const deliveryStates = new Set(['pending', 'running', 'error']);
  const cardMessageId = (receipt as { cardMessageId?: unknown }).cardMessageId;
  if (!Object.keys(parsed).every((key) => allowed.has(key))
    || !isUuid(receipt.taskId)
    || receipt.requestId !== receipt.taskId
    || receipt.status !== 'accepted'
    || receipt.targetBot !== body.botName
    || receipt.targetChatId !== body.chatId
    || typeof receipt.deliveryState !== 'string'
    || !deliveryStates.has(receipt.deliveryState)
    || !isNonEmptyString(receipt.message)
    || (cardMessageId !== undefined && (typeof cardMessageId !== 'string' || !cardMessageId.trim()))
    || (receipt.deliveryState === 'running' && typeof cardMessageId !== 'string')
    || (receipt.deliveryState !== 'running' && cardMessageId !== undefined)) {
    throw new Error('resident Bridge returned an invalid Agent Bus talk receipt');
  }
  return receipt as AgentTalkReceipt;
}

function validateTalkStatusReceipt(
  value: unknown,
  config: EngineTalkConfig,
  taskId: string,
): AgentTalkStatusReceipt {
  if (!isRecord(value)) {
    throw new Error('resident Bridge returned an invalid Agent Bus talk-status receipt');
  }
  const allowed = new Set([
    'taskId', 'status', 'botName', 'chatId', 'sourceBot', 'sourceChatId',
    'targetBot', 'targetChatId', 'cardMessageId', 'deliveryState',
    'createdAt', 'completedAt', 'result',
  ]);
  const status = value.status;
  const deliveryState = value.deliveryState;
  const cardMessageId = value.cardMessageId;
  const result = value.result;
  const terminal = status === 'completed' || status === 'failed';
  const validStatus = status === 'accepted' || status === 'running' || terminal;
  const validCard = cardMessageId === undefined || isNonEmptyString(cardMessageId);
  const validLifecycle = (
    (status === 'accepted' && deliveryState === 'accepted' && cardMessageId === undefined)
    || (status === 'running' && deliveryState === 'pending' && cardMessageId === undefined)
    || (status === 'running' && deliveryState === 'running' && isNonEmptyString(cardMessageId))
    || (status === 'running' && deliveryState === 'error' && cardMessageId === undefined)
    || (status === 'completed' && deliveryState === 'complete' && isNonEmptyString(cardMessageId))
    || (status === 'failed' && deliveryState === 'error')
  );
  const validResult = terminal
    ? isTerminalResult(result, status)
    : result === undefined;
  const createdAtMs = isIsoTimestamp(value.createdAt) ? Date.parse(value.createdAt) : Number.NaN;
  const completedAtMs = isIsoTimestamp(value.completedAt) ? Date.parse(value.completedAt) : Number.NaN;
  const validCompletion = terminal
    ? Number.isFinite(completedAtMs) && completedAtMs >= createdAtMs
    : value.completedAt === undefined;
  if (!Object.keys(value).every((key) => allowed.has(key))
    || !isUuid(value.taskId)
    || value.taskId !== taskId
    || !validStatus
    || value.sourceBot !== config.botName
    || value.sourceChatId !== config.chatId
    || value.targetBot !== config.botName
    || !isNonEmptyString(value.targetChatId)
    || value.botName !== value.targetBot
    || value.chatId !== value.targetChatId
    || !validCard
    || !validLifecycle
    || !Number.isFinite(createdAtMs)
    || !validCompletion
    || !validResult) {
    throw new Error('resident Bridge returned an invalid Agent Bus talk-status receipt');
  }
  return value as unknown as AgentTalkStatusReceipt;
}

async function bridgeTalkStatusRequest(config: EngineTalkConfig, taskId: string): Promise<AgentTalkStatusReceipt> {
  if (!isUuid(taskId)) {
    throw new Error('metabot agents talk-status: invalid taskId');
  }
  const response = await fetch(`${config.url.replace(/\/+$/, '')}/api/talk/${taskId}`, {
    headers: engineTalkHeaders(config),
  });
  const receipt = await parseBridgeResponse(response, `GET /api/talk/${taskId}`);
  return validateTalkStatusReceipt(receipt, config, taskId);
}

interface AgentRow {
  botName: string;
  url: string;
  visible: boolean;
  visibleToOwners?: string[];
  lastSeenAt: string;
  rulesPackStatus?: {
    state: 'inherited' | 'overridden' | 'opted-out' | 'unconfigured' | 'unsupported';
    required: boolean;
    mode?: 'off' | 'shadow' | 'enforce';
  };
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
  talk <peer>[/<bot>] [<chatId>] "<msg>" [--async] [--cards]
                                        Send a message to a peer's bot. When <chatId>
                                        is omitted, defaults to the cwd-derived
                                        project chatId.
                                        A signed engine session dispatches a same-
                                        Bridge target asynchronously and receives a
                                        task/card receipt. Other CLI agents route
                                        through metabot-core's central inbox relay.
  talk-status <taskId>                  Read one same-Bridge delegated task using
                                        the exact signed source Bot/Chat scope.

Env:
  METABOT_CORE_URL              memory + agents URL (default ${DEFAULT_BUS_URL})
  METABOT_CORE_AGENT_BUS_URL    override agents-only base URL (falls back to METABOT_CORE_URL)
  METABOT_CORE_TOKEN            bearer token (or ~/.metabot-core/token)
  METABOT_ENGINE_BRIDGE_URL     Bridge-injected capability-only loopback origin; do not configure manually
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
  // Allow omitting <chatId>: the cwd-derived chatId is the default so CC/Codex
  // users don't have to invent one. When omitted, positional[1] is the content.
  let chatId: string;
  let content: string | undefined;
  let chatIdSource: 'positional' | 'project' = 'positional';
  if (positional.length >= 3) {
    chatId = positional[1]!;
    content = positional[2];
  } else if (positional.length === 2) {
    chatId = deriveProjectChatId();
    content = positional[1];
    chatIdSource = 'project';
  } else {
    throw new Error('metabot agents talk: <peer>[/<bot>] [<chatId>] "<message>" required');
  }
  if (!target || content === undefined) {
    throw new Error('metabot agents talk: <peer>[/<bot>] [<chatId>] "<message>" required');
  }
  const slash = target.indexOf('/');
  const peerName = slash >= 0 ? target.slice(0, slash) : target;
  const botName = slash >= 0 ? target.slice(slash + 1) : target;
  if (!peerName) throw new Error('metabot agents talk: <peer> empty');
  if (!botName) throw new Error('metabot agents talk: <bot> empty after slash');

  const engineTalk = loadEngineTalkConfig();
  if (engineTalk) {
    if (slash >= 0 || botName !== engineTalk.botName) {
      throw new Error(
        'metabot agents talk: a signed engine session may delegate only the same Bot through its resident Bridge',
      );
    }
    if (chatIdSource === 'project') {
      process.stderr.write(`→ using project-derived chatId: ${chatId}\n`);
    }
    const receipt = await bridgeTalkRequest(engineTalk, { botName, chatId, prompt: content });
    print({ route: 'resident-bridge', ...receipt });
    return;
  }

  const cfg = loadBusConfig();
  const list = await busRequest<ListResponse>(cfg, 'GET', '/api/agents');
  const peer = (list.agents || []).find((a) => a.botName === peerName);
  if (!peer) {
    throw new Error(
      `metabot agents talk: peer '${peerName}' not in registry — run \`metabot agents list\` to see who's online`,
    );
  }
  if (!peer.url) throw new Error(`metabot agents talk: peer '${peerName}' has no url in registry`);

  const targetAgent = (list.agents || []).find((agent) => agent.botName === botName);
  const rulesPack = targetAgent?.rulesPackStatus;
  if (
    rulesPack &&
    (rulesPack.state === 'inherited' || rulesPack.state === 'overridden') &&
    (rulesPack.required || rulesPack.mode === 'shadow' || rulesPack.mode === 'enforce')
  ) {
    throw new Error(
      `metabot agents talk: target '${botName}' requires a sender-compiled RulesPack envelope; ` +
        'a signed same-Bridge engine session is required until cross-host FIX-014 is complete',
    );
  }

  if (chatIdSource === 'project') {
    process.stderr.write(`→ using project-derived chatId: ${chatId}\n`);
  }

  const resp = await busRequest(
    cfg, 'POST', `/api/inbox/${encodeURIComponent(botName)}`, { chatId, content },
  );
  process.stdout.write(`→ ${peerName}/${botName} @ ${chatId} (relay)\n`);
  if (typeof resp === 'object' && resp !== null) {
    // Surface the message id so the sender can correlate with audit logs.
    const id = (resp as { message?: { id?: unknown } }).message?.id;
    if (typeof id === 'string') process.stderr.write(`  id=${id}\n`);
  }
}

async function cmdTalkStatus(args: string[]): Promise<void> {
  const { positional } = parseArgs(args);
  const taskId = positional[0];
  if (!taskId) throw new Error('metabot agents talk-status: <taskId> required');
  const engineTalk = loadEngineTalkConfig();
  if (!engineTalk) {
    throw new Error('metabot agents talk-status: a signed engine session is required');
  }
  print(await bridgeTalkStatusRequest(engineTalk, taskId));
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
    case 'talk-status':
      return cmdTalkStatus(rest);
    default:
      process.stderr.write(`metabot agents: unknown subcommand '${sub}'\n\n`);
      process.stdout.write(usage());
      process.exit(2);
  }
}
