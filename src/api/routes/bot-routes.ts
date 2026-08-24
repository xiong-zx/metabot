import * as fs from 'node:fs';
import type * as http from 'node:http';
import { addBot, removeBot, updateBot, getBotEntry, addPeer, removePeer, readBotsConfig } from '../bots-config-writer.js';
import { installSkillsToWorkDir } from '../skills-installer.js';
import { parseFeishuDomain, webBotFromJson } from '../../config.js';
import { resolveEngineName } from '../../engines/index.js';
import { NullSender } from '../../web/null-sender.js';
import { MessageBridge } from '../../bridge/message-bridge.js';
import { jsonResponse, parseJsonBody } from './helpers.js';
import type { RouteContext } from './types.js';
import { MIN_PEER_SECRET_LENGTH } from '../peer-auth.js';
import type { PeerAuthConfig, PeerAuthKeyConfig } from '../../config.js';
import { handleRulesPackRoutes } from '../../extensions/rulespack-routes.js';
import {
  preflightRulesPackConfig,
  resolveRulesPackBotConfig,
  type RulesPackBotOverride,
} from '@metabot/rulespack-adapter';

export function parsePeerAuthConfig(value: unknown): PeerAuthConfig | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const auth = value as Record<string, unknown>;
  if (typeof auth.keyId !== 'string' || !auth.keyId.trim()) return undefined;
  if (typeof auth.secret !== 'string' || auth.secret.length < MIN_PEER_SECRET_LENGTH) return undefined;
  if (auth.sourceBot !== undefined && (typeof auth.sourceBot !== 'string' || !auth.sourceBot.trim())) {
    return undefined;
  }
  let acceptKeys: PeerAuthKeyConfig[] | undefined;
  if (auth.acceptKeys !== undefined) {
    if (!Array.isArray(auth.acceptKeys)) return undefined;
    acceptKeys = [];
    for (const candidate of auth.acceptKeys) {
      if (!candidate || typeof candidate !== 'object') return undefined;
      const key = candidate as Record<string, unknown>;
      if (typeof key.keyId !== 'string' || !key.keyId.trim()
        || typeof key.secret !== 'string' || key.secret.length < MIN_PEER_SECRET_LENGTH
        || typeof key.acceptUntil !== 'string' || !Number.isFinite(Date.parse(key.acceptUntil))) {
        return undefined;
      }
      acceptKeys.push({
        keyId: key.keyId.trim(),
        secret: key.secret,
        acceptUntil: key.acceptUntil,
      });
    }
  }
  const stringArray = (candidate: unknown): string[] | undefined => {
    if (candidate === undefined) return undefined;
    if (!Array.isArray(candidate) || !candidate.every((item) => typeof item === 'string' && item.trim())) {
      return undefined;
    }
    return candidate.map((item) => item.trim());
  };
  const revokedKeyIds = stringArray(auth.revokedKeyIds);
  const allowedSourceBots = stringArray(auth.allowedSourceBots);
  const allowedTargetBots = stringArray(auth.allowedTargetBots);
  if ((auth.revokedKeyIds !== undefined && !revokedKeyIds)
    || (auth.allowedSourceBots !== undefined && !allowedSourceBots)
    || (auth.allowedTargetBots !== undefined && !allowedTargetBots)) {
    return undefined;
  }
  return {
    keyId: auth.keyId.trim(),
    secret: auth.secret,
    ...(typeof auth.sourceBot === 'string' ? { sourceBot: auth.sourceBot.trim() } : {}),
    ...(acceptKeys ? { acceptKeys } : {}),
    ...(revokedKeyIds ? { revokedKeyIds } : {}),
    ...(allowedSourceBots ? { allowedSourceBots } : {}),
    ...(allowedTargetBots ? { allowedTargetBots } : {}),
  };
}

export async function handleBotRoutes(
  ctx: RouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  url: string,
): Promise<boolean> {
  const { registry, logger, botsConfigPath, peerManager, ws } = ctx;

  if (await handleRulesPackRoutes(ctx, req, res, method, url)) return true;

  // GET /api/bots/:name/profile — detailed bot profile with stats
  if (method === 'GET' && /^\/api\/bots\/[^/]+\/profile$/.test(url)) {
    const botName = decodeURIComponent(url.split('/')[3]);
    const bot = registry.get(botName);
    if (!bot) {
      jsonResponse(res, 404, { error: `Bot not found: ${botName}` });
      return true;
    }
    const stats = bot.bridge.costTracker.getStats();
    const botStats = stats.byBot[botName];
    jsonResponse(res, 200, {
      name: bot.name,
      description: bot.config.description,
      specialties: bot.config.specialties,
      icon: bot.config.icon,
      platform: bot.platform,
      engine: resolveEngineName(bot.config),
      model: defaultModelForConfig(bot.config),
      workingDirectory: bot.config.claude.defaultWorkingDirectory,
      rulesPackStatus: bot.config.rulesPackPolicy,
      maxConcurrentTasks: bot.config.maxConcurrentTasks,
      budgetLimitDaily: bot.config.budgetLimitDaily,
      stats: botStats || { totalTasks: 0, completedTasks: 0, failedTasks: 0, totalCostUsd: 0 },
    });
    return true;
  }

  // GET /api/bots
  if (method === 'GET' && url === '/api/bots') {
    const localBots = registry.list();
    const peerBots = peerManager?.getPeerBots() ?? [];
    jsonResponse(res, 200, { bots: [...localBots, ...peerBots] });
    return true;
  }

  // GET /api/peers
  if (method === 'GET' && url === '/api/peers') {
    jsonResponse(res, 200, { peers: peerManager?.getPeerStatuses() ?? [] });
    return true;
  }

  // POST /api/peers — add a static peer at runtime (no restart)
  if (method === 'POST' && url === '/api/peers') {
    if (!peerManager) {
      jsonResponse(res, 400, { error: 'Peering is disabled (no PeerManager configured)' });
      return true;
    }
    const body = await parseJsonBody(req);
    const name = (body.name as string)?.trim();
    const peerUrl = (body.url as string)?.trim();
    const legacySecret = (body.secret as string) || undefined;
    const auth = parsePeerAuthConfig(body.auth);
    if (!name || !peerUrl) {
      jsonResponse(res, 400, { error: 'Missing required fields: name, url' });
      return true;
    }
    if (!/^https?:\/\//i.test(peerUrl)) {
      jsonResponse(res, 400, { error: 'url must start with http:// or https://' });
      return true;
    }
    if (legacySecret) {
      jsonResponse(res, 400, {
        error: 'peer.secret is deprecated and cannot be added; use scoped peer auth',
        code: 'legacy_peer_secret_rejected',
      });
      return true;
    }
    if (body.auth !== undefined && !auth) {
      jsonResponse(res, 400, {
        error: `auth requires keyId and a secret of at least ${MIN_PEER_SECRET_LENGTH} characters`,
        code: 'invalid_peer_auth',
      });
      return true;
    }

    peerManager.addPeer({ name, url: peerUrl, ...(auth ? { auth } : {}) });

    // Persist to bots.json so the peer survives a restart (best-effort).
    let persisted = false;
    if (botsConfigPath) {
      try {
        addPeer(botsConfigPath, { name, url: peerUrl, ...(auth ? { auth } : {}) });
        persisted = true;
      } catch (err: any) {
        logger.warn({ name, err: err?.message }, 'peer added in-memory but persisting to bots.json failed');
      }
    }
    logger.info({ name, url: peerUrl, persisted }, 'peer added at runtime');
    jsonResponse(res, 201, {
      name,
      url: peerUrl,
      persisted,
      message: persisted
        ? 'Peer added and persisted. Active immediately, no restart needed.'
        : 'Peer added (in-memory only — set BOTS_CONFIG to persist across restarts).',
    });
    return true;
  }

  // DELETE /api/peers/:name — remove a peer at runtime
  if (method === 'DELETE' && url.startsWith('/api/peers/')) {
    if (!peerManager) {
      jsonResponse(res, 400, { error: 'Peering is disabled (no PeerManager configured)' });
      return true;
    }
    const name = decodeURIComponent(url.slice('/api/peers/'.length));
    if (!name) {
      jsonResponse(res, 400, { error: 'Missing peer name' });
      return true;
    }
    const removed = peerManager.removePeer(name);
    let persistedRemoval = false;
    if (botsConfigPath) {
      try {
        persistedRemoval = removePeer(botsConfigPath, name);
      } catch (err: any) {
        logger.warn({ name, err: err?.message }, 'peer removed in-memory but updating bots.json failed');
      }
    }
    if (!removed && !persistedRemoval) {
      jsonResponse(res, 404, { error: `Peer not found: ${name}` });
      return true;
    }
    logger.info({ name, persistedRemoval }, 'peer removed at runtime');
    jsonResponse(res, 200, { name, removed: true });
    return true;
  }

  // POST /api/bots — create a new bot
  if (method === 'POST' && url === '/api/bots') {
    if (!botsConfigPath) {
      jsonResponse(res, 400, { error: 'Bot CRUD requires BOTS_CONFIG to be set' });
      return true;
    }
    const body = await parseJsonBody(req);
    const platform = body.platform as string;
    const name = body.name as string;

    if (!platform || !name) {
      jsonResponse(res, 400, { error: 'Missing required fields: platform, name' });
      return true;
    }
    if (platform !== 'feishu' && platform !== 'telegram' && platform !== 'web' && platform !== 'slack') {
      jsonResponse(res, 400, { error: 'platform must be "feishu", "telegram", "web", or "slack"' });
      return true;
    }

    let entry: Record<string, unknown>;
    if (platform === 'feishu') {
      const appId = body.feishuAppId as string;
      const appSecret = body.feishuAppSecret as string;
      const workDir = body.defaultWorkingDirectory as string;
      if (!appId || !appSecret || !workDir) {
        jsonResponse(res, 400, { error: 'Feishu bot requires: feishuAppId, feishuAppSecret, defaultWorkingDirectory' });
        return true;
      }
      let feishuDomain;
      try {
        feishuDomain = parseFeishuDomain(body.feishuDomain);
      } catch (err: any) {
        jsonResponse(res, 400, { error: err.message });
        return true;
      }
      entry = {
        name,
        ...(body.description ? { description: body.description } : {}),
        ...(body.engine ? { engine: body.engine } : {}),
        ...(body.codex ? { codex: body.codex } : {}),
        ...(body.kimi ? { kimi: body.kimi } : {}),
        feishuAppId: appId,
        feishuAppSecret: appSecret,
        feishuDomain,
        defaultWorkingDirectory: workDir,
        ...(body.maxTurns ? { maxTurns: body.maxTurns } : {}),
        ...(body.maxBudgetUsd ? { maxBudgetUsd: body.maxBudgetUsd } : {}),
        ...(body.model ? { model: body.model } : {}),
      };
    } else if (platform === 'telegram') {
      const token = body.telegramBotToken as string;
      const workDir = body.defaultWorkingDirectory as string;
      if (!token || !workDir) {
        jsonResponse(res, 400, { error: 'Telegram bot requires: telegramBotToken, defaultWorkingDirectory' });
        return true;
      }
      entry = {
        name,
        ...(body.description ? { description: body.description } : {}),
        ...(body.engine ? { engine: body.engine } : {}),
        ...(body.codex ? { codex: body.codex } : {}),
        ...(body.kimi ? { kimi: body.kimi } : {}),
        telegramBotToken: token,
        defaultWorkingDirectory: workDir,
        ...(body.maxTurns ? { maxTurns: body.maxTurns } : {}),
        ...(body.maxBudgetUsd ? { maxBudgetUsd: body.maxBudgetUsd } : {}),
        ...(body.model ? { model: body.model } : {}),
      };
    } else if (platform === 'web') {
      const workDir = body.defaultWorkingDirectory as string;
      if (!workDir) {
        jsonResponse(res, 400, { error: 'Web bot requires: defaultWorkingDirectory' });
        return true;
      }
      entry = {
        name,
        ...(body.description ? { description: body.description } : {}),
        ...(body.engine ? { engine: body.engine } : {}),
        ...(body.codex ? { codex: body.codex } : {}),
        ...(body.kimi ? { kimi: body.kimi } : {}),
        defaultWorkingDirectory: workDir,
        ...(body.maxTurns ? { maxTurns: body.maxTurns } : {}),
        ...(body.maxBudgetUsd ? { maxBudgetUsd: body.maxBudgetUsd } : {}),
        ...(body.model ? { model: body.model } : {}),
      };
    } else {
      const token = body.slackBotToken as string;
      const signingSecret = body.slackSigningSecret as string;
      const workDir = body.defaultWorkingDirectory as string;
      if (!token || !signingSecret || !workDir) {
        jsonResponse(res, 400, {
          error: 'Slack bot requires: slackBotToken, slackSigningSecret, defaultWorkingDirectory',
        });
        return true;
      }
      entry = {
        name,
        ...(body.description ? { description: body.description } : {}),
        ...(body.engine ? { engine: body.engine } : {}),
        ...(body.codex ? { codex: body.codex } : {}),
        ...(body.kimi ? { kimi: body.kimi } : {}),
        slackBotToken: token,
        slackSigningSecret: signingSecret,
        ...(body.slackBotUserId ? { slackBotUserId: body.slackBotUserId } : {}),
        ...(body.groupNoMention ? { groupNoMention: true } : {}),
        defaultWorkingDirectory: workDir,
        ...(body.maxTurns ? { maxTurns: body.maxTurns } : {}),
        ...(body.maxBudgetUsd ? { maxBudgetUsd: body.maxBudgetUsd } : {}),
        ...(body.model ? { model: body.model } : {}),
      };
    }

    const rulesPackDefaults = readBotsConfig(botsConfigPath).rulesPackDefaults;
    try {
      const resolved = resolveRulesPackBotConfig({
        botName: name,
        engine: resolveEntryEngine(entry),
        defaults: rulesPackDefaults,
        ...(Object.hasOwn(body, 'rulesPack') ? { override: body.rulesPack as RulesPackBotOverride } : {}),
        ...(typeof body.rulesPackOptOutReason === 'string'
          ? { optOutReason: body.rulesPackOptOutReason }
          : {}),
      });
      if (Object.hasOwn(body, 'rulesPack')) entry.rulesPack = body.rulesPack;
      if (typeof body.rulesPackOptOutReason === 'string') {
        entry.rulesPackOptOutReason = body.rulesPackOptOutReason;
      }
      if (resolved.rulesPack) await preflightRulesPackConfig(resolved.rulesPack, logger);
    } catch (err: any) {
      jsonResponse(res, 400, { error: err.message });
      return true;
    }

    let pendingWeb: { config: ReturnType<typeof webBotFromJson>; sender: NullSender; bridge: MessageBridge } | undefined;
    try {
      const workDir = body.defaultWorkingDirectory as string;
      fs.mkdirSync(workDir, { recursive: true });

      if (platform === 'web') {
        const config = webBotFromJson(entry as any, rulesPackDefaults);
        const sender = new NullSender();
        const bridge = new MessageBridge(config, logger, sender);
        pendingWeb = { config, sender, bridge };
        await bridge.getRulesPackOperator()?.refresh();
      }

      if (body.installSkills) {
        installSkillsToWorkDir(workDir, logger, {
          platform: platform as 'feishu' | 'telegram' | 'web' | 'slack',
          ...(platform === 'feishu' ? {
            feishuAppId: entry.feishuAppId as string,
            feishuAppSecret: entry.feishuAppSecret as string,
            feishuDomain: parseFeishuDomain(entry.feishuDomain),
          } : {}),
        });
      }

      addBot(botsConfigPath, platform as 'feishu' | 'telegram' | 'web' | 'slack', entry as any);
      logger.info({ name, platform }, 'Bot added to config');

      let activated = false;
      if (pendingWeb) {
        registry.register({ name, platform: 'web', ...pendingWeb });
        activated = true;
        logger.info({ name }, 'Web bot activated immediately');
        ws.handle?.broadcastBotList();
      }

      jsonResponse(res, 201, {
        name,
        platform,
        workingDirectory: workDir,
        message: activated ? 'Bot added and activated.' : 'Bot added. PM2 will restart to activate it.',
      });
    } catch (err: any) {
      await pendingWeb?.bridge.destroyAsync();
      if (err.message?.includes('already exists')) {
        jsonResponse(res, 409, { error: err.message });
      } else {
        jsonResponse(res, 400, { error: err.message });
      }
    }
    return true;
  }

  // PUT /api/bots/:name — update an existing bot
  if (method === 'PUT' && url.startsWith('/api/bots/')) {
    const name = decodeURIComponent(url.slice('/api/bots/'.length));
    if (!name) {
      jsonResponse(res, 400, { error: 'Missing bot name' });
      return true;
    }
    if (!botsConfigPath) {
      jsonResponse(res, 400, { error: 'Bot CRUD requires BOTS_CONFIG to be set' });
      return true;
    }
    const body = await parseJsonBody(req);
    const current = getBotEntry(botsConfigPath, name);
    if (!current) {
      jsonResponse(res, 404, { error: `Bot not found: ${name}` });
      return true;
    }
    if (Object.hasOwn(body, 'feishuDomain')) {
      if (current.platform !== 'feishu') {
        jsonResponse(res, 400, { error: 'feishuDomain can only be set on Feishu bots' });
        return true;
      }
      if (current.platform === 'feishu') {
        try {
          body.feishuDomain = parseFeishuDomain(body.feishuDomain);
        } catch (err: any) {
          jsonResponse(res, 400, { error: err.message });
          return true;
        }
      }
    }
    const candidate = { ...(current.entry as unknown as Record<string, unknown>) };
    for (const [key, value] of Object.entries(body)) {
      if (key === 'name' || key === 'platform') continue;
      if (value === undefined || value === null || value === '') delete candidate[key];
      else candidate[key] = value;
    }
    try {
      const defaults = readBotsConfig(botsConfigPath).rulesPackDefaults;
      const resolved = resolveRulesPackBotConfig({
        botName: name,
        engine: resolveEntryEngine(candidate),
        defaults,
        ...(Object.hasOwn(candidate, 'rulesPack') ? { override: candidate.rulesPack as RulesPackBotOverride } : {}),
        ...(typeof candidate.rulesPackOptOutReason === 'string'
          ? { optOutReason: candidate.rulesPackOptOutReason }
          : {}),
      });
      if (resolved.rulesPack) await preflightRulesPackConfig(resolved.rulesPack, logger);
    } catch (err: any) {
      jsonResponse(res, 400, { error: err.message });
      return true;
    }
    const updated = updateBot(botsConfigPath, name, body);
    if (!updated) {
      jsonResponse(res, 404, { error: `Bot not found: ${name}` });
      return true;
    }
    logger.info({ name, updates: Object.keys(body) }, 'Bot config updated');
    ws.handle?.broadcastBotList();
    jsonResponse(res, 200, { name, updated: true });
    return true;
  }

  // GET /api/bots/:name
  if (method === 'GET' && url.startsWith('/api/bots/')) {
    const name = decodeURIComponent(url.slice('/api/bots/'.length));
    if (!name) {
      jsonResponse(res, 400, { error: 'Missing bot name' });
      return true;
    }

    const running = registry.get(name);
    const runningInfo = running
      ? { running: true, workingDirectory: running.config.claude.defaultWorkingDirectory }
      : { running: false };

    if (botsConfigPath) {
      const found = getBotEntry(botsConfigPath, name);
      if (found) {
        jsonResponse(res, 200, { name, platform: found.platform, ...runningInfo, config: found.entry });
        return true;
      }
    }

    if (running) {
      jsonResponse(res, 200, { name, platform: running.platform, ...runningInfo });
      return true;
    }

    jsonResponse(res, 404, { error: `Bot not found: ${name}` });
    return true;
  }

  // DELETE /api/bots/:name
  if (method === 'DELETE' && url.startsWith('/api/bots/')) {
    const name = decodeURIComponent(url.slice('/api/bots/'.length));
    if (!name) {
      jsonResponse(res, 400, { error: 'Missing bot name' });
      return true;
    }
    if (!botsConfigPath) {
      jsonResponse(res, 400, { error: 'Bot CRUD requires BOTS_CONFIG to be set' });
      return true;
    }

    try {
      const removed = removeBot(botsConfigPath, name);
      if (!removed) {
        jsonResponse(res, 404, { error: `Bot not found: ${name}` });
        return true;
      }
      registry.deregister(name);
      logger.info({ name }, 'Bot removed from config');
      ws.handle?.broadcastBotList();
      jsonResponse(res, 200, { name, removed: true, message: 'Bot removed.' });
    } catch (err: any) {
      if (err.message?.includes('Cannot remove the last bot')) {
        jsonResponse(res, 400, { error: err.message });
      } else {
        throw err;
      }
    }
    return true;
  }

  return false;
}

function resolveEntryEngine(entry: Record<string, unknown>): 'claude' | 'kimi' | 'codex' {
  const engine = entry.engine;
  if (engine === undefined) {
    const defaultEngine = process.env.METABOT_ENGINE;
    return defaultEngine === 'claude' || defaultEngine === 'kimi' || defaultEngine === 'codex'
      ? defaultEngine
      : 'codex';
  }
  if (engine === 'claude' || engine === 'kimi' || engine === 'codex') return engine;
  throw new Error('engine must be "codex", "kimi", or "claude"');
}

function defaultModelForConfig(config: import('../../config.js').BotConfigBase): string | undefined {
  switch (resolveEngineName(config)) {
    case 'claude':
      return config.claude.model;
    case 'kimi':
      return config.kimi?.model;
    case 'codex':
      return config.codex?.model || config.codex?.displayModel;
  }
}
