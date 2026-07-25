import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import type { Logger } from '../../utils/logger.js';

const SEED_FILES = ['auth.json', 'config.toml', 'models_cache.json'];

function codexHomesBaseDir(): string {
  return process.env.METABOT_CODEX_HOMES_DIR
    || path.join(process.env.SESSION_STORE_DIR || path.join(homedir(), '.metabot'), 'codex-homes');
}

function globalCodexHome(): string {
  return process.env.CODEX_HOME || path.join(homedir(), '.codex');
}

/** Stable, readable, collision-safe directory name for a workdir path. */
export function workdirHomeSlug(cwd: string): string {
  const normalized = path.resolve(cwd);
  const base = path.basename(normalized).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) || 'root';
  const hash = createHash('sha1').update(normalized).digest('hex').slice(0, 8);
  return `${base}-${hash}`;
}

/**
 * Where a workdir's isolated CODEX_HOME lives. Pure path math — read-only
 * callers (session listing) need the location without creating or seeding it.
 */
export function workdirCodexHomePath(cwd: string): string {
  return path.join(codexHomesBaseDir(), workdirHomeSlug(cwd));
}

/**
 * Ensure a per-workdir Codex home exists and is seeded from the global home.
 * The bot defaults to Codex's global home; this helper is used only when
 * `codex.homeScope` is set to `workdir`.
 */
export function prepareWorkdirCodexHome(cwd: string, logger: Logger): string {
  const home = workdirCodexHomePath(cwd);
  const fresh = !existsSync(home);
  mkdirSync(home, { recursive: true });

  const global = globalCodexHome();
  for (const file of SEED_FILES) {
    const src = path.join(global, file);
    const dst = path.join(home, file);
    try {
      if (!existsSync(src)) continue;
      if (!existsSync(dst) || statSync(src).mtimeMs > statSync(dst).mtimeMs) {
        copyFileSync(src, dst);
      }
    } catch (err) {
      logger.warn({ err, src, dst }, 'codex-home: failed to seed file');
    }
  }

  if (fresh) {
    logger.info({ cwd, home }, 'codex-home: created per-workdir CODEX_HOME');
  }
  return home;
}
