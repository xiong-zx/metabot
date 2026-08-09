import * as path from 'node:path';
import type { FeishuDomain } from '../feishu/domain.js';
import { MemoryClient } from '../memory/memory-client.js';
import type { Logger } from '../utils/logger.js';
import { DocSync } from './doc-sync.js';
import { defaultWikiAutoSyncConsumer, WikiAutoSync } from './wiki-auto-sync.js';

export interface WikiSyncServiceCredentials {
  appId: string;
  appSecret: string;
  domain: FeishuDomain;
}

export interface WikiSyncRuntime {
  docSync?: DocSync;
  wikiAutoSync?: WikiAutoSync;
}

export interface WikiSyncRuntimeOptions {
  feishuService?: WikiSyncServiceCredentials;
  logger: Logger;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

/** Build the optional Wiki services and enforce auto-sync's fail-closed gates. */
export function createWikiSyncRuntime(options: WikiSyncRuntimeOptions): WikiSyncRuntime {
  const env = options.env ?? process.env;
  const autoSyncEnabled = explicitTrue(env.WIKI_AUTO_SYNC);
  if (autoSyncEnabled && env.WIKI_SYNC_ENABLED === 'false') {
    throw new Error('WIKI_AUTO_SYNC=true requires WIKI_SYNC_ENABLED=true');
  }
  if (!options.feishuService || env.WIKI_SYNC_ENABLED === 'false') {
    if (autoSyncEnabled) {
      throw new Error('WIKI_AUTO_SYNC=true requires Feishu service credentials and Wiki sync');
    }
    return {};
  }

  const configuredStateDir = env.WIKI_SYNC_STATE_DIR?.trim();
  const wikiSpaceId = env.WIKI_SPACE_ID?.trim() || undefined;
  const rootNodeToken = env.WIKI_SYNC_ROOT_NODE_TOKEN?.trim() || undefined;
  if (autoSyncEnabled) {
    const missing = [
      !wikiSpaceId && 'WIKI_SPACE_ID',
      !rootNodeToken && 'WIKI_SYNC_ROOT_NODE_TOKEN',
      !configuredStateDir && 'WIKI_SYNC_STATE_DIR',
    ].filter(Boolean);
    if (missing.length > 0) {
      throw new Error(`WIKI_AUTO_SYNC=true requires explicit ${missing.join(', ')}`);
    }
  }
  if (explicitTrue(env.WIKI_SYNC_DELETE_REMOTE) && !rootNodeToken) {
    throw new Error('WIKI_SYNC_DELETE_REMOTE=true requires WIKI_SYNC_ROOT_NODE_TOKEN');
  }

  const syncStateDir = configuredStateDir
    ? path.resolve(options.cwd ?? process.cwd(), configuredStateDir)
    : path.join(options.cwd ?? process.cwd(), 'data');
  const memoryClient = new MemoryClient(options.logger);
  const docSync = new DocSync(
    {
      feishuAppId: options.feishuService.appId,
      feishuAppSecret: options.feishuService.appSecret,
      feishuDomain: options.feishuService.domain,
      databaseDir: syncStateDir,
      wikiSpaceName: env.WIKI_SPACE_NAME || 'MetaMemory',
      wikiSpaceId,
      rootNodeToken,
      deleteRemoteDocuments: explicitTrue(env.WIKI_SYNC_DELETE_REMOTE),
      throttleMs: positiveInt(env.WIKI_SYNC_THROTTLE_MS, 300, 'WIKI_SYNC_THROTTLE_MS', options.logger),
    },
    memoryClient,
    options.logger,
  );

  const wikiAutoSync = autoSyncEnabled
    ? new WikiAutoSync(
        {
          consumer: env.WIKI_AUTO_SYNC_CONSUMER?.trim() || defaultWikiAutoSyncConsumer(wikiSpaceId!, rootNodeToken!),
          pollMs: positiveInt(env.WIKI_AUTO_SYNC_POLL_MS, 5_000, 'WIKI_AUTO_SYNC_POLL_MS', options.logger),
          batchSize: positiveInt(env.WIKI_AUTO_SYNC_BATCH_SIZE, 100, 'WIKI_AUTO_SYNC_BATCH_SIZE', options.logger),
          fullReconcileMs: positiveInt(
            env.WIKI_AUTO_SYNC_FULL_RECONCILE_MS,
            6 * 60 * 60_000,
            'WIKI_AUTO_SYNC_FULL_RECONCILE_MS',
            options.logger,
          ),
          maxAttempts: positiveInt(env.WIKI_AUTO_SYNC_MAX_ATTEMPTS, 5, 'WIKI_AUTO_SYNC_MAX_ATTEMPTS', options.logger),
          watchRoot: env.WIKI_AUTO_SYNC_WATCH_ROOT?.trim() || '/',
        },
        docSync,
        memoryClient,
        options.logger,
      )
    : undefined;

  options.logger.info(
    { autoSync: autoSyncEnabled, spaceId: wikiSpaceId, rootNodeToken },
    autoSyncEnabled
      ? 'Root-isolated Wiki sync service initialized with durable auto-sync'
      : 'Wiki sync service initialized for manual /sync',
  );
  return { docSync, wikiAutoSync };
}

function explicitTrue(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true';
}

function positiveInt(raw: string | undefined, fallback: number, name: string, logger: Logger): number {
  if (!raw?.trim()) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  logger.warn({ name, value: raw, defaultValue: fallback }, 'Invalid positive integer env value; using default');
  return fallback;
}
