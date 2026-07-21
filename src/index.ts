import * as https from 'node:https';
import * as path from 'node:path';
import * as lark from '@larksuiteoapi/node-sdk';
import { loadAppConfig, type BotConfig } from './config.js';
import { createLogger, type Logger } from './utils/logger.js';
import { createEventDispatcher } from './feishu/event-handler.js';
import { MessageSender } from './feishu/message-sender.js';
import { FeishuSenderAdapter } from './feishu/feishu-sender-adapter.js';
import { MessageBridge } from './bridge/message-bridge.js';
import { loadRestartBreadcrumb } from './bridge/restart-notice.js';
import type { IMessageSender } from './bridge/message-sender.interface.js';
import type { BotConfigBase } from './config.js';
import { startTelegramBot } from './telegram/telegram-bot.js';
import { startWechatBot } from './wechat/wechat-bot.js';
import { BotRegistry } from './api/bot-registry.js';
import { NullSender } from './web/null-sender.js';
import { PeerManager } from './api/peer-manager.js';
import { TaskScheduler } from './scheduler/task-scheduler.js';
import { WorkerManager } from './workers/worker-manager.js';
import { startApiServer } from './api/http-server.js';
import { DocSync } from './sync/doc-sync.js';
import { WikiAutoSync } from './sync/auto-sync.js';
import { MemoryClient } from './memory/memory-client.js';
import { checkMetabotCoreMemoryConnection } from './memory/core-connection.js';
import { recoverInterruptedTasksAfterRestart } from './bridge/restart-recovery.js';
import { cleanupStaleBridgeDirs } from './engines/claude/pty/hook-bridge.js';

import { SessionRegistry } from './session/session-registry.js';

interface FeishuBotHandle {
  name: string;
  bridge: MessageBridge;
  wsClient: lark.WSClient;
  config: BotConfigBase;
  sender: IMessageSender;
  feishuClient: lark.Client;
  lastEventAt: { value: number };
  dispatcher: lark.EventDispatcher;
  feishuCreds: { appId: string; appSecret: string };
}

function envFlag(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return defaultValue;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  return defaultValue;
}

function envPositiveInt(name: string, defaultValue: number, logger: Logger): number {
  const raw = process.env[name]?.trim();
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    logger.warn({ name, value: raw, defaultValue }, 'Invalid positive integer env value; using default');
    return defaultValue;
  }
  return parsed;
}

function envNonNegativeInt(name: string, defaultValue: number, logger: Logger): number {
  const raw = process.env[name]?.trim();
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    logger.warn({ name, value: raw, defaultValue }, 'Invalid non-negative integer env value; using default');
    return defaultValue;
  }
  return parsed;
}

/**
 * METABOT_LOCAL_ADDRESS=<source-ip> pins the source address of every Feishu
 * socket (REST + the wss long-connection), so the OS routes them out the
 * interface owning that IP instead of the default route. Workaround for VPN
 * clients with smart split-tunneling (e.g. some corporate VPNs) that capture *.feishu.cn
 * into a tunnel that is actually down while still claiming connected: live
 * sockets held by an old process keep working, but the next restart can't
 * reconnect and every bot goes silent — looking like the upgrade broke it.
 *
 * REST coverage works by setting the agent on the lark SDK's shared
 * `defaultHttpInstance`, which every `lark.Client` here uses (bot clients,
 * the Feishu service client, DocSync). Mutating it — rather than passing a
 * custom `httpInstance` — keeps the SDK's own interceptors intact; a custom
 * axios instance must re-implement the response-unwrap interceptor or the
 * SDK's internal tenant-token fetch destructures `code` from the wrapped
 * body and silently breaks ("code: undefined"). The returned agent must
 * additionally be passed to each `lark.WSClient`, whose `agent` option goes
 * straight to the underlying wss socket.
 *
 * Native-fetch traffic is deliberately NOT touched (no undici global
 * dispatcher): nothing in this codebase calls Feishu via fetch, and a global
 * dispatcher would also re-route peer/metabot-core traffic out of scope.
 *
 * Unset (the default) → returns undefined and nothing is constructed.
 */
function setupFeishuLocalAddress(logger: Logger): https.Agent | undefined {
  const localAddress = process.env.METABOT_LOCAL_ADDRESS?.trim();
  if (!localAddress) return undefined;
  const agent = new https.Agent({ keepAlive: true, localAddress });
  lark.defaultHttpInstance.defaults.httpsAgent = agent;
  logger.info({ localAddress }, 'Feishu sockets bound to local address (METABOT_LOCAL_ADDRESS)');
  return agent;
}

async function startFeishuBot(botConfig: BotConfig, logger: Logger, localAgent?: https.Agent): Promise<FeishuBotHandle> {
  const botLogger = logger.child({ bot: botConfig.name });

  botLogger.info('Starting Feishu bot...');

  // Create Feishu API client
  const client = new lark.Client({
    appId: botConfig.feishu.appId,
    appSecret: botConfig.feishu.appSecret,
    disableTokenCache: false,
  });

  // Fetch bot info to get bot's open_id for accurate @mention detection
  let botOpenId: string | undefined;
  try {
    const botInfo: any = await client.request({ method: 'GET', url: '/open-apis/bot/v3/info' });
    botOpenId = botInfo?.bot?.open_id;
    if (botOpenId) {
      botLogger.info({ botOpenId }, 'Bot info fetched');
    } else {
      botLogger.warn('Could not get bot open_id. Ensure the Feishu app has Bot capability enabled and the app version is published.');
    }
  } catch (err: any) {
    botLogger.warn({ err: err?.message || err }, 'Failed to fetch bot info. Check: 1) Bot capability is enabled in Feishu app 2) App is published 3) App credentials are correct');
  }

  // Create sender and bridge (FeishuSenderAdapter wraps the Feishu-specific MessageSender)
  const rawSender = new MessageSender(client, botLogger);
  const sender = new FeishuSenderAdapter(rawSender);
  const bridge = new MessageBridge(botConfig, botLogger, sender);
  const lastEventAt = { value: Date.now() };

  // Create event dispatcher wired to the bridge
  const dispatcher = createEventDispatcher(
    botConfig,
    botLogger,
    (msg) => {
      bridge.handleMessage(msg).catch((err) => {
        botLogger.error({ err, msg }, 'Unhandled error in message bridge');
      });
    },
    botOpenId,
    rawSender,
    (event) => {
      bridge.handleCardAction(event).catch((err) => {
        botLogger.error({ err, event }, 'Unhandled error in card action handler');
      });
    },
    () => { lastEventAt.value = Date.now(); },
  );

  // Create WebSocket client
  const wsClient = new lark.WSClient({
    appId: botConfig.feishu.appId,
    appSecret: botConfig.feishu.appSecret,
    loggerLevel: lark.LoggerLevel.info,
    agent: localAgent,
  });

  // Start WebSocket connection with event dispatcher
  await wsClient.start({ eventDispatcher: dispatcher });

  botLogger.info('Feishu bot is running');
  botLogger.info({
    defaultWorkingDirectory: botConfig.claude.defaultWorkingDirectory,
    maxTurns: botConfig.claude.maxTurns ?? 'unlimited',
    maxBudgetUsd: botConfig.claude.maxBudgetUsd ?? 'unlimited',
  }, 'Configuration');

  return {
    name: botConfig.name,
    bridge,
    wsClient,
    config: botConfig,
    sender,
    feishuClient: client,
    lastEventAt,
    dispatcher,
    feishuCreds: { appId: botConfig.feishu.appId, appSecret: botConfig.feishu.appSecret },
  };
}

/**
 * Filter the loaded bot set by env so a SECOND metabot instance can run just
 * one bot (e.g. to dogfood the PTY backend) without disturbing production:
 *   - METABOT_ONLY_BOTS=<a,b>    keep only these bot names (whitelist)
 *   - METABOT_EXCLUDE_BOTS=<a,b> drop these bot names (blacklist)
 * Both are comma-separated and applied across every platform array. The
 * production instance EXCLUDES the test bot; the test instance runs ONLY it
 * (on a different API_PORT). This avoids two processes fighting over one
 * bot's Feishu long-connection.
 */
function applyBotFilter(appConfig: ReturnType<typeof loadAppConfig>, logger: Logger): void {
  const parse = (v?: string) =>
    new Set((v ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  const only = parse(process.env.METABOT_ONLY_BOTS);
  const exclude = parse(process.env.METABOT_EXCLUDE_BOTS);
  if (only.size === 0 && exclude.size === 0) return;

  const keep = (name: string): boolean => {
    if (only.size > 0 && !only.has(name)) return false;
    if (exclude.has(name)) return false;
    return true;
  };
  const before = {
    feishu: appConfig.feishuBots.length,
    telegram: appConfig.telegramBots.length,
    web: appConfig.webBots.length,
    wechat: appConfig.wechatBots.length,
  };
  appConfig.feishuBots = appConfig.feishuBots.filter((b) => keep(b.name));
  appConfig.telegramBots = appConfig.telegramBots.filter((b) => keep(b.name));
  appConfig.webBots = appConfig.webBots.filter((b) => keep(b.name));
  appConfig.wechatBots = appConfig.wechatBots.filter((b) => keep(b.name));
  logger.info(
    {
      only: [...only],
      exclude: [...exclude],
      before,
      after: {
        feishu: appConfig.feishuBots.length,
        telegram: appConfig.telegramBots.length,
        web: appConfig.webBots.length,
        wechat: appConfig.wechatBots.length,
      },
    },
    'Bot filter applied (METABOT_ONLY_BOTS / METABOT_EXCLUDE_BOTS)',
  );
}

async function main() {
  const appConfig = loadAppConfig();
  const logger = createLogger(appConfig.log.level);
  applyBotFilter(appConfig, logger);

  // Read (and clear) the restart breadcrumb left by `metabot restart/update`,
  // so the first turn in each chat after a restart can be reminded not to
  // restart again. Must run before any message can be handled.
  loadRestartBreadcrumb();

  // Orphaned PTY hook-bridge temp dirs (`/tmp/metabot-pty-*`) accumulate
  // across crashes/restarts because dispose() only runs on normal teardown.
  // Safe to sweep unconditionally here: this process hasn't created any
  // bridges yet, so everything matching the pattern belongs to a prior run.
  // Must stay before any bot starts (claude-engine bots create bridges).
  const staleBridgeDirs = cleanupStaleBridgeDirs(logger);
  if (staleBridgeDirs > 0) {
    logger.info({ count: staleBridgeDirs }, 'Cleaned up stale PTY hook-bridge temp dirs from a previous run');
  }

  const feishuCount = appConfig.feishuBots.length;
  const telegramCount = appConfig.telegramBots.length;
  const wechatCount = appConfig.wechatBots.length;
  logger.info({ feishuBots: feishuCount, telegramBots: telegramCount, wechatBots: wechatCount }, 'Starting MetaBot bridge...');

  // Create bot registry
  const registry = new BotRegistry();

  // Must run before ANY lark.Client makes a request (token fetches included)
  // so no Feishu socket ever goes out the default route.
  const feishuLocalAgent = setupFeishuLocalAddress(logger);

  // Start bots independently so a single platform/API timeout does not
  // take down the whole MetaBot process.
  const feishuHandles = feishuCount > 0
    ? await startBotsSafely(
      appConfig.feishuBots,
      (bot) => startFeishuBot(bot, logger, feishuLocalAgent),
      logger,
      'feishu',
    )
    : [];

  const telegramHandles = telegramCount > 0
    ? await startBotsSafely(
      appConfig.telegramBots,
      (bot) => startTelegramBot(bot, logger),
      logger,
      'telegram',
    )
    : [];

  const wechatHandles = wechatCount > 0
    ? await startBotsSafely(
      appConfig.wechatBots,
      (bot) => startWechatBot(bot, logger),
      logger,
      'wechat',
    )
    : [];

  const wsWatchdogStaleMs = process.env.METABOT_WS_WATCHDOG_STALE_MS
    ? parseInt(process.env.METABOT_WS_WATCHDOG_STALE_MS, 10)
    : 7 * 60 * 1000;
  if (feishuHandles.length > 0 && wsWatchdogStaleMs > 0) {
    const tappedSockets = new WeakSet<object>();
    const rebuildingBots = new Set<string>();
    const tapFrames = (handle: FeishuBotHandle) => {
      try {
        const inst = (handle.wsClient as unknown as {
          wsConfig?: { getWSInstance?: () => { on: (ev: string, fn: () => void) => void } | undefined };
        }).wsConfig?.getWSInstance?.();
        if (inst && !tappedSockets.has(inst)) {
          tappedSockets.add(inst);
          inst.on('message', () => { handle.lastEventAt.value = Date.now(); });
        }
      } catch {
        // SDK internals shifted; dispatcher-level liveness still applies.
      }
    };
    for (const handle of feishuHandles) tapFrames(handle);

    const rebuildWsClient = async (handle: FeishuBotHandle, silentMs: number) => {
      logger.warn({ bot: handle.name, silentSec: Math.round(silentMs / 1000) }, 'WS watchdog: no Feishu frames; rebuilding wsClient');
      handle.lastEventAt.value = Date.now();
      rebuildingBots.add(handle.name);
      const old = handle.wsClient;
      try {
        const fresh = new lark.WSClient({
          appId: handle.feishuCreds.appId,
          appSecret: handle.feishuCreds.appSecret,
          loggerLevel: lark.LoggerLevel.info,
          agent: feishuLocalAgent,
        });
        await fresh.start({ eventDispatcher: handle.dispatcher });
        handle.wsClient = fresh;
        tapFrames(handle);
        try {
          old.close({ force: true });
        } catch (err) {
          logger.warn({ err, bot: handle.name }, 'WS watchdog: stale wsClient close failed');
        }
        logger.info({ bot: handle.name }, 'WS watchdog: wsClient rebuilt');
      } catch (err) {
        logger.error({ err, bot: handle.name }, 'WS watchdog: wsClient rebuild failed');
      } finally {
        rebuildingBots.delete(handle.name);
      }
    };

    setInterval(() => {
      for (const handle of feishuHandles) {
        tapFrames(handle);
        const silentMs = Date.now() - handle.lastEventAt.value;
        if (silentMs < wsWatchdogStaleMs) continue;
        if (rebuildingBots.has(handle.name)) continue;
        void rebuildWsClient(handle, silentMs);
      }
    }, 60 * 1000).unref();
    logger.info({ staleMs: wsWatchdogStaleMs }, 'Feishu WS watchdog armed');
  }

  // Register all bots in the registry
  for (const handle of feishuHandles) {
    registry.register({
      name: handle.name,
      platform: 'feishu',
      config: handle.config,
      bridge: handle.bridge,
      sender: handle.sender,
      feishuClient: handle.feishuClient,
    });
  }

  for (const handle of telegramHandles) {
    registry.register({
      name: handle.name,
      platform: 'telegram',
      config: handle.config,
      bridge: handle.bridge,
      sender: handle.sender,
    });
  }

  // Register web-only bots (no IM platform — accessible via Web UI only)
  for (const webConfig of appConfig.webBots) {
    const botLogger = logger.child({ bot: webConfig.name });
    const sender = new NullSender();
    const bridge = new MessageBridge(webConfig, botLogger, sender);
    registry.register({ name: webConfig.name, platform: 'web', config: webConfig, bridge, sender });
  }

  for (const handle of wechatHandles) {
    registry.register({
      name: handle.name,
      platform: 'wechat',
      config: handle.config,
      bridge: handle.bridge,
      sender: handle.sender,
    });
  }

  const allNames = [
    ...feishuHandles.map((h) => h.name),
    ...telegramHandles.map((h) => h.name),
    ...appConfig.webBots.map((b) => b.name),
    ...wechatHandles.map((h) => h.name),
  ];
  logger.info({ bots: allNames }, 'All bots started');

  // Create task scheduler
  const scheduler = new TaskScheduler(registry, logger);

  const workerManager = new WorkerManager(registry, logger, {
    defaultModel: appConfig.workers.defaultModel,
    maxPerPm: appConfig.workers.maxPerPm,
  });
  for (const info of registry.list()) {
    const bot = registry.get(info.name);
    if (!bot) continue;
    bot.bridge.setScheduler(scheduler);
    bot.bridge.setWorkerManager(workerManager);
  }
  logger.info(
    { defaultModel: appConfig.workers.defaultModel, maxPerPm: appConfig.workers.maxPerPm },
    'Worker manager initialized',
  );
  await recoverInterruptedTasksAfterRestart({ registry, scheduler, logger });

  const memoryCheck = await checkMetabotCoreMemoryConnection({ timeoutMs: 4_000 });
  if (memoryCheck.ok) {
    logger.info({
      baseUrl: memoryCheck.baseUrl,
      tokenSource: memoryCheck.tokenSource,
      folderCount: memoryCheck.folderCount,
      documentCount: memoryCheck.documentCount,
      durationMs: memoryCheck.durationMs,
    }, 'MetaMemory connected via metabot-core');
  } else {
    logger.warn({
      baseUrl: memoryCheck.baseUrl,
      tokenPresent: memoryCheck.tokenPresent,
      tokenSource: memoryCheck.tokenSource,
      status: memoryCheck.status,
      error: memoryCheck.error,
      durationMs: memoryCheck.durationMs,
    }, 'MetaMemory is not reachable; memory features will fail until METABOT_CORE_URL/METABOT_CORE_TOKEN are fixed');
  }

  // Initialize peer manager for cross-instance bot discovery.
  // Registry mode (env METABOT_CORE_AGENT_BUS_URL or METABOT_CORE_URL — the
  // central server URL) lets the bridge boot peerManager even with zero
  // static peers — it discovers them via the central /api/agents endpoint
  // on the first poll tick. The local bot list is the full set of bots
  // configured in bots.json; visibility (per bot) is passed through to the
  // bulk-register call so `visible:false` rows are hidden in the registry.
  const localBotsForRegistry = [
    ...appConfig.feishuBots.map((b) => ({ name: b.name, visible: b.visible, memoryPublic: b.memoryPublic })),
    ...appConfig.telegramBots.map((b) => ({ name: b.name, visible: b.visible, memoryPublic: b.memoryPublic })),
    ...appConfig.webBots.map((b) => ({ name: b.name, visible: b.visible, memoryPublic: b.memoryPublic })),
    ...appConfig.wechatBots.map((b) => ({ name: b.name, visible: b.visible, memoryPublic: b.memoryPublic })),
  ];
  let peerManager: PeerManager | undefined;
  if (
    appConfig.peers.length > 0 ||
    process.env.METABOT_CORE_AGENT_BUS_URL?.trim() ||
    process.env.METABOT_CORE_URL?.trim()
  ) {
    peerManager = new PeerManager(appConfig.peers, localBotsForRegistry, logger);
    await peerManager.refreshAll();
    const statuses = peerManager.getPeerStatuses();
    const healthyCount = statuses.filter((s) => s.healthy).length;
    logger.info({ peerCount: statuses.length, healthyPeers: healthyCount }, 'Peer manager initialized');
  }

  // Create a dedicated Feishu service client for wiki sync & doc reader
  let feishuServiceClient: lark.Client | undefined;
  if (appConfig.feishuService) {
    feishuServiceClient = new lark.Client({
      appId: appConfig.feishuService.appId,
      appSecret: appConfig.feishuService.appSecret,
      disableTokenCache: false,
    });
    logger.info('Feishu service client initialized (for wiki sync & doc reader)');
  }

  // Initialize wiki sync service (uses dedicated service app credentials)
  let docSync: DocSync | undefined;
  let wikiAutoSync: WikiAutoSync | undefined;
  if (appConfig.feishuService && envFlag('WIKI_SYNC_ENABLED', true)) {
    const syncMemoryClient = new MemoryClient(logger);
    const syncStateDir = process.env.WIKI_SYNC_STATE_DIR
      ? path.resolve(process.env.WIKI_SYNC_STATE_DIR)
      : path.join(process.cwd(), 'data');
    docSync = new DocSync(
      {
        feishuAppId: appConfig.feishuService.appId,
        feishuAppSecret: appConfig.feishuService.appSecret,
        databaseDir: syncStateDir,
        wikiSpaceName: process.env.WIKI_SPACE_NAME || 'MetaMemory',
        wikiSpaceId: process.env.WIKI_SPACE_ID || undefined,
        throttleMs: process.env.WIKI_SYNC_THROTTLE_MS ? parseInt(process.env.WIKI_SYNC_THROTTLE_MS, 10) : undefined,
        deleteStaleDocuments: envFlag('WIKI_SYNC_DELETE_STALE_DOCS', true),
      },
      syncMemoryClient,
      logger,
    );
    // Inject into all Feishu bot bridges
    for (const handle of feishuHandles) {
      handle.bridge.setDocSync(docSync);
    }
    const autoSyncEnabled = envFlag('WIKI_AUTO_SYNC', true);
    if (autoSyncEnabled) {
      const autoSyncPollMs = envPositiveInt('WIKI_AUTO_SYNC_POLL_MS', 60_000, logger);
      const autoSyncDebounceMs = envNonNegativeInt('WIKI_AUTO_SYNC_DEBOUNCE_MS', 5_000, logger);
      const autoSyncOnStart = envFlag('WIKI_AUTO_SYNC_ON_START', true);
      wikiAutoSync = new WikiAutoSync(
        {
          pollMs: autoSyncPollMs,
          debounceMs: autoSyncDebounceMs,
          syncOnStart: autoSyncOnStart,
        },
        docSync,
        syncMemoryClient,
        logger,
      );
      wikiAutoSync.start();
      logger.info({
        pollMs: autoSyncPollMs,
        debounceMs: autoSyncDebounceMs,
        syncOnStart: autoSyncOnStart,
      }, 'Wiki auto-sync service initialized');
    }
    logger.info({ autoSyncEnabled }, 'Wiki sync service initialized');
  }

  // Initialize cross-platform session registry
  const sessionRegistry = new SessionRegistry(logger);
  // Inject into all bot bridges
  for (const info of registry.list()) {
    const bot = registry.get(info.name);
    if (bot) bot.bridge.setSessionRegistry(sessionRegistry);
  }

  // Resolve bots config path for API-driven bot CRUD
  const botsConfigPath = process.env.BOTS_CONFIG
    ? path.resolve(process.env.BOTS_CONFIG)
    : undefined;

  // Start API server
  const apiServer = startApiServer({
    port: appConfig.api.port,
    secret: appConfig.api.secret,
    registry,
    scheduler,
    logger,
    botsConfigPath,
    docSync,
    feishuServiceClient,
    peerManager,
    sessionRegistry,
    agentTeams: appConfig.agentTeams,
    agentTeamExecutionBot: appConfig.agentTeamExecutionBot,
    workerManager,
  });

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...');
    scheduler.destroy();
    if (peerManager) {
      peerManager.destroy();
    }
    apiServer.close();
    if (docSync) {
      wikiAutoSync?.destroy();
      docSync.destroy();
    }
    sessionRegistry.close();
    const teardowns: Promise<void>[] = [];
    for (const handle of feishuHandles) {
      teardowns.push(handle.bridge.destroyAsync());
    }
    for (const handle of telegramHandles) {
      teardowns.push(handle.bridge.destroyAsync());
      handle.bot.stop();
    }
    for (const handle of wechatHandles) {
      teardowns.push(handle.bridge.destroyAsync());
      handle.stop();
    }
    // Cap teardown wait so a hung executor can't block exit indefinitely
    await Promise.race([
      Promise.allSettled(teardowns),
      new Promise((resolve) => setTimeout(resolve, 15_000)),
    ]);
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function startBotsSafely<TConfig extends BotConfigBase, THandle>(
  bots: TConfig[],
  starter: (bot: TConfig) => Promise<THandle>,
  logger: Logger,
  platform: 'feishu' | 'telegram' | 'wechat',
): Promise<THandle[]> {
  const results = await Promise.allSettled(bots.map((bot) => starter(bot)));
  const handles: THandle[] = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const bot = bots[i];
    if (!result || !bot) continue;

    if (result.status === 'fulfilled') {
      handles.push(result.value);
      continue;
    }

    logger.error(
      { err: result.reason, botName: bot.name, platform },
      'Failed to start bot; continuing with remaining bots',
    );
  }

  return handles;
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
