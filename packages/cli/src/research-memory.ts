import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArgs, print } from '@xvirobotics/cli-core';

interface BridgeConfig {
  url: string;
  token: string;
}

type HttpMethod = 'GET' | 'POST';

function usage(): string {
  return `metabot research-memory — Unified Memory Core bridge CLI

Subcommands:
  events list [--root <path>]
  events log --type <event_type> --summary <text> [--body <text>] [--root <path>] [--project <id>] [--run <id>] [--domain <name>] [--visibility private|project]
    note: --type fact is accepted as an alias for finding
  units [--root <path>]
  runs [--root <path>] [--project <id>]
  artifacts [--root <path>] [--project <id>] [--run <id>]
  search <query...> [--root <path>] [--project <id>] [--run <id>] [--domain <name>] [--limit <n>]
  context-pack <query...> [--root <path>] [--purpose research|coding|review|planning|ops|report] [--token-budget <n>] [--project <id>] [--domain <name>] [--include-candidates]
  dispatch <task...> --project <id> --bot <name> --chat <id> [--root <path>] [--run <id>] [--domain <name>] [--review]
  ingest <autoresearchclaw-output.json> [--root <path>] [--project <id>] [--run <id>] [--domain <name>] [--review]
  promote request <eventId> --visibility domain|global [--domain <name>] [--root <path>]
  promote approve <requestEventId> --visibility domain|global [--domain <name>] [--root <path>]
  promote reject <requestEventId> [--root <path>]
  supersede <targetEventId> [replacementEventId] [--root <path>] [--visibility project|domain|global] [--project <id>] [--domain <name>]
  redact <targetEventId> [--root <path>] [--visibility project|domain|global] [--project <id>] [--domain <name>] [--reason <text>]

Aliases:
  metabot research <...>   same as research-memory

Env:
  METABOT_URL      bridge base URL (default http://localhost:$API_PORT)
  API_PORT         bridge port (default 9100)
  API_SECRET       bridge bearer token (default changeme)
`;
}

export async function run(argv: string[]): Promise<void> {
  const cmd = argv[0];
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    print(usage());
    return;
  }

  const cfg = loadBridgeConfig();
  const rest = argv.slice(1);
  switch (cmd) {
    case 'events':
      await runEvents(cfg, rest);
      return;
    case 'units':
      await runUnits(cfg, rest);
      return;
    case 'runs':
      await runRuns(cfg, rest);
      return;
    case 'artifacts':
      await runArtifacts(cfg, rest);
      return;
    case 'search':
      await runSearch(cfg, rest);
      return;
    case 'context-pack':
      await runContextPack(cfg, rest);
      return;
    case 'dispatch':
      await runDispatch(cfg, rest);
      return;
    case 'ingest':
      await runIngest(cfg, rest);
      return;
    case 'promote':
      await runPromote(cfg, rest);
      return;
    case 'supersede':
      await runSupersede(cfg, rest);
      return;
    case 'redact':
      await runRedact(cfg, rest);
      return;
    default:
      throw new Error(`metabot research-memory: unknown subcommand '${cmd}'`);
  }
}

async function runEvents(cfg: BridgeConfig, argv: string[]): Promise<void> {
  const action = argv[0];
  const { positional, flags } = parseArgs(argv.slice(1));
  if (action === 'list') {
    print(await bridgeRequest(cfg, 'GET', `/api/research-memory/events?${rootQuery(flags)}`));
    return;
  }
  if (action === 'log') {
    const type = normalizeEventType(requiredString(flags.type, 'events log: --type required'));
    const event = {
      type,
      summary: requiredString(flags.summary, 'events log: --summary required'),
      body: stringFlag(flags, 'body'),
      actor: actorFromFlags(flags, 'agent', 'cli'),
      scope: scopeFromFlags(flags, 'project'),
      status: stringFlag(flags, 'status'),
    };
    print(await bridgeRequest(cfg, 'POST', '/api/research-memory/events', { root: rootFromFlags(flags), event }));
    return;
  }
  throw new Error(`metabot research-memory events: expected list or log, got '${action ?? positional[0] ?? ''}'`);
}

function normalizeEventType(value: string): string {
  return value === 'fact' ? 'finding' : value;
}

async function runUnits(cfg: BridgeConfig, argv: string[]): Promise<void> {
  const { flags } = parseArgs(argv);
  print(await bridgeRequest(cfg, 'GET', `/api/research-memory/units?${rootQuery(flags)}`));
}

async function runRuns(cfg: BridgeConfig, argv: string[]): Promise<void> {
  const { flags } = parseArgs(argv);
  const params = new URLSearchParams({ root: rootFromFlags(flags) });
  addOptionalParam(params, 'projectId', stringFlag(flags, 'project'));
  print(await bridgeRequest(cfg, 'GET', `/api/research-memory/runs?${params.toString()}`));
}

async function runArtifacts(cfg: BridgeConfig, argv: string[]): Promise<void> {
  const { flags } = parseArgs(argv);
  const params = new URLSearchParams({ root: rootFromFlags(flags) });
  addOptionalParam(params, 'projectId', stringFlag(flags, 'project'));
  addOptionalParam(params, 'runId', stringFlag(flags, 'run'));
  print(await bridgeRequest(cfg, 'GET', `/api/research-memory/artifacts?${params.toString()}`));
}

async function runSearch(cfg: BridgeConfig, argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  const query = positional.join(' ').trim() || stringFlag(flags, 'query') || stringFlag(flags, 'q') || '';
  const params = new URLSearchParams({ root: rootFromFlags(flags), q: query });
  addOptionalParam(params, 'projectId', stringFlag(flags, 'project'));
  addOptionalParam(params, 'runId', stringFlag(flags, 'run'));
  addOptionalParam(params, 'domain', stringFlag(flags, 'domain'));
  addOptionalParam(params, 'limit', stringFlag(flags, 'limit'));
  print(await bridgeRequest(cfg, 'GET', `/api/research-memory/search?${params.toString()}`));
}

async function runContextPack(cfg: BridgeConfig, argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  const query = positional.join(' ').trim() || requiredString(flags.query, 'context-pack: query required');
  print(
    await bridgeRequest(cfg, 'POST', '/api/research-memory/context-pack', {
      root: rootFromFlags(flags),
      purpose: stringFlag(flags, 'purpose') ?? 'research',
      query,
      tokenBudget: numberFlag(flags, 'token-budget') ?? numberFlag(flags, 'tokenBudget') ?? 4000,
      includeCandidates: boolFlag(flags, 'include-candidates') || boolFlag(flags, 'includeCandidates'),
      scopeFilter: scopeFilterFromFlags(flags),
      actor: maybeActorFromFlags(flags),
      scope: maybeScopeFromFlags(flags),
    }),
  );
}

async function runDispatch(cfg: BridgeConfig, argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  const task = positional.join(' ').trim() || requiredString(flags.task, 'dispatch: task required');
  const botName = stringFlag(flags, 'bot') ?? stringFlag(flags, 'botName') ?? process.env.METABOT_BOT_NAME;
  const pmChatId = stringFlag(flags, 'chat') ?? stringFlag(flags, 'pmChatId') ?? process.env.METABOT_CHAT_ID;
  print(
    await bridgeRequest(cfg, 'POST', '/api/research-memory/research-loop/dispatch', {
      root: rootFromFlags(flags),
      projectId: requiredString(flags.project, 'dispatch: --project required'),
      runId: stringFlag(flags, 'run'),
      task,
      domain: stringFlag(flags, 'domain'),
      botName: requiredString(botName, 'dispatch: --bot or METABOT_BOT_NAME required'),
      pmChatId: requiredString(pmChatId, 'dispatch: --chat or METABOT_CHAT_ID required'),
      tokenBudget: numberFlag(flags, 'token-budget') ?? numberFlag(flags, 'tokenBudget'),
      reviewRequired: boolFlag(flags, 'review'),
      model: stringFlag(flags, 'model'),
      engine: stringFlag(flags, 'engine'),
      reasoningEffort: stringFlag(flags, 'reasoning-effort') ?? stringFlag(flags, 'reasoningEffort'),
      approvalPolicy: stringFlag(flags, 'approval-policy') ?? stringFlag(flags, 'approvalPolicy'),
      sandbox: stringFlag(flags, 'sandbox'),
      timeoutMs: numberFlag(flags, 'timeout-ms') ?? numberFlag(flags, 'timeoutMs'),
      idleTimeoutMs: numberFlag(flags, 'idle-timeout-ms') ?? numberFlag(flags, 'idleTimeoutMs'),
    }),
  );
}

async function runIngest(cfg: BridgeConfig, argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  const file = positional[0];
  if (!file) throw new Error('metabot research-memory ingest: <autoresearchclaw-output.json> required');
  const output = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')) as unknown;
  print(
    await bridgeRequest(cfg, 'POST', '/api/research-memory/autoresearchclaw/ingest', {
      root: rootFromFlags(flags),
      output,
      actor: actorFromFlags(flags, 'agent', 'autoresearchclaw'),
      scope: scopeFromFlags(flags, 'project'),
      workerEventId: stringFlag(flags, 'worker-event-id') ?? stringFlag(flags, 'workerEventId'),
      timestamp: stringFlag(flags, 'timestamp'),
      reviewRequired: boolFlag(flags, 'review'),
    }),
  );
}

async function runPromote(cfg: BridgeConfig, argv: string[]): Promise<void> {
  const action = argv[0];
  const { positional, flags } = parseArgs(argv.slice(1));
  if (action === 'request') {
    const targetEventId = positional[0];
    if (!targetEventId) throw new Error('metabot research-memory promote request: <eventId> required');
    print(
      await bridgeRequest(cfg, 'POST', '/api/research-memory/promotions/request', {
        root: rootFromFlags(flags),
        targetEventId,
        targetVisibility: requiredString(flags.visibility, 'promote request: --visibility required'),
        targetDomain: stringFlag(flags, 'domain'),
        actor: actorFromFlags(flags, 'agent', 'memory-curator'),
        scope: scopeFromFlags(flags, 'project'),
        reason: stringFlag(flags, 'reason'),
      }),
    );
    return;
  }
  if (action === 'approve') {
    const requestEventId = positional[0];
    if (!requestEventId) throw new Error('metabot research-memory promote approve: <requestEventId> required');
    print(
      await bridgeRequest(cfg, 'POST', '/api/research-memory/promotions/approve', {
        root: rootFromFlags(flags),
        requestEventId,
        actor: actorFromFlags(flags, 'user', 'cli-user'),
        scope: scopeFromFlags(flags, stringFlag(flags, 'visibility') ?? 'domain'),
        reason: stringFlag(flags, 'reason'),
      }),
    );
    return;
  }
  if (action === 'reject') {
    const requestEventId = positional[0];
    if (!requestEventId) throw new Error('metabot research-memory promote reject: <requestEventId> required');
    print(
      await bridgeRequest(cfg, 'POST', '/api/research-memory/promotions/reject', {
        root: rootFromFlags(flags),
        requestEventId,
        actor: actorFromFlags(flags, 'user', 'cli-user'),
        scope: scopeFromFlags(flags, stringFlag(flags, 'visibility') ?? 'domain'),
        reason: stringFlag(flags, 'reason'),
      }),
    );
    return;
  }
  throw new Error(`metabot research-memory promote: expected request, approve, or reject, got '${action ?? ''}'`);
}

async function runSupersede(cfg: BridgeConfig, argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  const targetEventId = positional[0];
  if (!targetEventId) throw new Error('metabot research-memory supersede: <targetEventId> required');
  print(
    await bridgeRequest(cfg, 'POST', '/api/research-memory/supersede', {
      root: rootFromFlags(flags),
      targetEventId,
      replacementEventId: positional[1],
      actor: actorFromFlags(flags, 'agent', 'memory-curator'),
      scope: scopeFromFlags(flags, stringFlag(flags, 'visibility') ?? 'project'),
      reason: stringFlag(flags, 'reason'),
    }),
  );
}

async function runRedact(cfg: BridgeConfig, argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  const targetEventId = positional[0];
  if (!targetEventId) throw new Error('metabot research-memory redact: <targetEventId> required');
  print(
    await bridgeRequest(cfg, 'POST', '/api/research-memory/redact', {
      root: rootFromFlags(flags),
      targetEventId,
      actor: actorFromFlags(flags, 'user', 'cli-user'),
      scope: scopeFromFlags(flags, stringFlag(flags, 'visibility') ?? 'project'),
      reason: stringFlag(flags, 'reason'),
    }),
  );
}

function loadBridgeConfig(): BridgeConfig {
  const port = process.env.API_PORT || '9100';
  const url = (process.env.METABOT_URL || `http://localhost:${port}`).replace(/\/+$/, '');
  const token = process.env.API_SECRET || 'changeme';
  return { url, token };
}

async function bridgeRequest<T = unknown>(
  cfg: BridgeConfig,
  method: HttpMethod,
  route: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.token}`,
    Accept: 'application/json',
  };
  if (process.env.METABOT_MEMORY_ADMIN_TOKEN !== undefined && process.env.METABOT_MEMORY_ADMIN_TOKEN.length > 0) {
    headers['X-Metabot-Memory-Admin-Token'] = process.env.METABOT_MEMORY_ADMIN_TOKEN;
  }
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(cfg.url + route, init);
  const text = await res.text();
  const parsed = parseResponseText(text);
  if (!res.ok) {
    const message =
      typeof parsed === 'object' && parsed !== null && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : String(parsed);
    throw new Error(`bridge ${method} ${route} -> ${res.status}: ${message}`);
  }
  return parsed as T;
}

function parseResponseText(text: string): unknown {
  if (text.length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function rootQuery(flags: Record<string, string | true>): string {
  return new URLSearchParams({ root: rootFromFlags(flags) }).toString();
}

function rootFromFlags(flags: Record<string, string | true>): string {
  return path.resolve(stringFlag(flags, 'root') ?? process.cwd());
}

function actorFromFlags(
  flags: Record<string, string | true>,
  defaultKind: string,
  defaultId: string,
): { kind: string; id: string } {
  return {
    kind: stringFlag(flags, 'actor-kind') ?? stringFlag(flags, 'actorKind') ?? defaultKind,
    id: stringFlag(flags, 'actor-id') ?? stringFlag(flags, 'actorId') ?? defaultId,
  };
}

function maybeActorFromFlags(flags: Record<string, string | true>): { kind: string; id: string } | undefined {
  if (
    stringFlag(flags, 'actor-kind') === undefined &&
    stringFlag(flags, 'actorKind') === undefined &&
    stringFlag(flags, 'actor-id') === undefined &&
    stringFlag(flags, 'actorId') === undefined
  ) {
    return undefined;
  }
  return actorFromFlags(flags, 'agent', 'cli');
}

function scopeFromFlags(
  flags: Record<string, string | true>,
  defaultVisibility: string,
): { project_id?: string; run_id?: string; domain?: string; visibility: string } {
  return {
    project_id: stringFlag(flags, 'project'),
    run_id: stringFlag(flags, 'run'),
    domain: stringFlag(flags, 'domain'),
    visibility: stringFlag(flags, 'visibility') ?? defaultVisibility,
  };
}

function maybeScopeFromFlags(
  flags: Record<string, string | true>,
): { project_id?: string; run_id?: string; domain?: string; visibility: string } | undefined {
  if (
    stringFlag(flags, 'project') === undefined &&
    stringFlag(flags, 'run') === undefined &&
    stringFlag(flags, 'domain') === undefined &&
    stringFlag(flags, 'visibility') === undefined
  ) {
    return undefined;
  }
  return scopeFromFlags(flags, 'project');
}

function scopeFilterFromFlags(flags: Record<string, string | true>): Record<string, unknown> {
  return compact({
    project_id: stringFlag(flags, 'project'),
    run_id: stringFlag(flags, 'run'),
    domain: stringFlag(flags, 'domain'),
  });
}

function addOptionalParam(params: URLSearchParams, key: string, value: string | undefined): void {
  if (value !== undefined) {
    params.set(key, value);
  }
}

function stringFlag(flags: Record<string, string | true>, name: string): string | undefined {
  return typeof flags[name] === 'string' ? flags[name] : undefined;
}

function requiredString(value: string | true | undefined, message: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(message);
  }
  return value.trim();
}

function boolFlag(flags: Record<string, string | true>, name: string): boolean {
  return flags[name] === true || flags[name] === 'true' || flags[name] === '1';
}

function numberFlag(flags: Record<string, string | true>, name: string): number | undefined {
  const value = stringFlag(flags, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`--${name} must be a finite number`);
  }
  return parsed;
}

function compact(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}
