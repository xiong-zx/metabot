#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const targetRoot = path.resolve(process.argv[2] || '');
const appName = process.argv[3] || 'metabot';
if (!process.argv[2] || !fs.existsSync(path.join(targetRoot, 'ecosystem.config.cjs'))) {
  console.error('Usage: pm2-atomic-runtime-switch.cjs <runtime-dir> [app-name]');
  process.exit(2);
}

const SHARED_ENV_KEYS = new Set([
  'BOTS_CONFIG',
  'SESSION_STORE_DIR',
  'METABOT_DEFAULT_ENV_FILE',
  'WIKI_SYNC_STATE_DIR',
  'API_PORT',
  'API_SECRET',
  'LOG_LEVEL',
  'META_MEMORY_URL',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'REQUESTS_CA_BUNDLE',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
]);

const SHARED_ENV_PREFIXES = [
  'FEISHU_',
  'TELEGRAM_',
  'WECHAT_',
  'MEMORY_',
  'METABOT_CORE_',
  'METABOT_MEMORY_',
  'WIKI_',
];

const DEPLOYMENT_ENV_KEYS = [
  'METABOT_RESTART_REQUEST_ID',
  'METABOT_RESTART_REASON',
  'METABOT_RESTART_SOURCE',
  'METABOT_RESTART_RESUME',
  'METABOT_BOT_NAME',
  'METABOT_CHAT_ID',
];

function selectSharedEnvironment(currentEnv) {
  return Object.fromEntries(Object.entries(currentEnv || {}).filter(([key, value]) => (
    value !== undefined
    && value !== null
    && (SHARED_ENV_KEYS.has(key) || SHARED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)))
  )));
}

function resolvePm2Root() {
  if (process.env.PM2_MODULE_ROOT) return path.resolve(process.env.PM2_MODULE_ROOT);
  const pm2Bin = execFileSync('which', ['pm2'], { encoding: 'utf8' }).trim();
  const resolvedBin = fs.realpathSync(pm2Bin);
  return path.dirname(path.dirname(resolvedBin));
}

let pm2;
let Common;
let target;
try {
  const pm2Root = resolvePm2Root();
  const pkg = require(path.join(pm2Root, 'package.json'));
  const major = Number.parseInt(String(pkg.version || '').split('.')[0], 10);
  if (!Number.isFinite(major) || major < 5) {
    throw new Error(`Unsupported PM2 version ${pkg.version || 'unknown'}; refusing runtime switch`);
  }
  pm2 = require(pm2Root);
  Common = require(path.join(pm2Root, 'lib', 'Common.js'));
  if (typeof pm2.connect !== 'function'
    || typeof pm2.list !== 'function'
    || typeof pm2.Client?.executeRemote !== 'function'
    || typeof Common.verifyConfs !== 'function'
    || typeof Common.resolveAppAttributes !== 'function'
    || typeof Common.mergeEnvironmentVariables !== 'function') {
    throw new Error(`PM2 ${pkg.version || 'unknown'} does not expose the required atomic restart API`);
  }
  const ecosystemPath = path.join(targetRoot, 'ecosystem.config.cjs');
  delete require.cache[require.resolve(ecosystemPath)];
  const ecosystem = require(ecosystemPath);
  const app = (ecosystem.apps || []).find((entry) => entry && entry.name === appName);
  if (!app) throw new Error(`App ${appName} is missing from ${ecosystemPath}`);
  const [verifiedApp] = Common.verifyConfs([app]);
  if (!verifiedApp) throw new Error(`App ${appName} failed PM2 configuration validation`);
  target = Common.resolveAppAttributes({ cwd: targetRoot, pm2_home: pm2.pm2_home }, verifiedApp);
  if (!target.env) target.env = {};
  target.env.PM2_HOME = pm2.pm2_home;
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
}

pm2.connect((connectError) => {
  if (connectError) return finish(connectError);
  pm2.list((listError, rows) => {
    if (listError) return finish(listError);
    const current = rows.find((row) => row.name === appName);
    if (!current) return finish(new Error(`PM2 app ${appName} is not running; use metabot start from the target runtime`));

    // PM2's public startOrRestart path intentionally treats cwd/script as
    // immutable and updates only env. Its daemon restart RPC can atomically
    // apply a fully resolved current_conf without deleting the app entry.
    const env = Common.mergeEnvironmentVariables(target);
    const inheritedEnv = selectSharedEnvironment(current.pm2_env?.env);
    const targetEnv = env.current_conf?.env || {};
    const deploymentEnv = Object.fromEntries(DEPLOYMENT_ENV_KEYS.map((key) => [key, process.env[key] || '']));
    const mergedEnv = { ...inheritedEnv, ...targetEnv, ...deploymentEnv };
    Object.assign(env, mergedEnv);
    env.current_conf.env = mergedEnv;
    pm2.Client.executeRemote('restartProcessId', { id: current.pm_id, env }, (restartError) => {
      if (restartError) return finish(restartError);
      pm2.list((verifyError, updatedRows) => {
        if (verifyError) return finish(verifyError);
        const updated = updatedRows.find((row) => row.name === appName);
        const updatedEnv = updated && updated.pm2_env;
        if (!updatedEnv
          || updatedEnv.status !== 'online'
          || path.resolve(updatedEnv.pm_cwd || '') !== targetRoot
          || path.resolve(updatedEnv.pm_exec_path || '') !== path.resolve(target.pm_exec_path)) {
          return finish(new Error(`PM2 accepted restart but runtime verification failed for ${appName}`));
        }
        process.stdout.write(`${JSON.stringify({
          ok: true,
          app: appName,
          pid: updated.pid,
          cwd: updatedEnv.pm_cwd,
          script: updatedEnv.pm_exec_path,
        })}\n`);
        finish();
      });
    });
  });
});

function finish(err) {
  try { pm2 && pm2.disconnect(); } catch { /* ignore */ }
  if (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
