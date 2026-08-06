#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ALLOWED_APPS = new Set(['metabot', 'metabot-worker-runnerd', 'metabot-arcd', 'metabot-core']);
const PROXY_KEYS = new Set([
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
]);
const SHARED_KEYS = new Set([
  'BOTS_CONFIG',
  'SESSION_STORE_DIR',
  'API_PORT',
  'API_SECRET',
  'LOG_LEVEL',
  'META_MEMORY_URL',
  'REQUESTS_CA_BUNDLE',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  ...PROXY_KEYS,
]);
const SHARED_PREFIXES = [
  'FEISHU_', 'TELEGRAM_', 'WECHAT_', 'MEMORY_', 'META_MEMORY_', 'WIKI_', 'METABOT_',
];
const EXCLUDED_SHARED_KEYS = new Set([
  'METABOT_HOME',
  'METABOT_REEXEC',
]);
const DEPLOYMENT_KEYS = [
  'METABOT_RESTART_REQUEST_ID',
  'METABOT_RESTART_REASON',
  'METABOT_RESTART_SOURCE',
  'METABOT_RESTART_RESUME',
  'METABOT_BOT_NAME',
  'METABOT_CHAT_ID',
];
const VERIFY_TIMEOUT_MS = 15_000;

function parseArgs(argv) {
  const flags = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value.startsWith('--')) throw new Error(`Unexpected argument: ${value}`);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) throw new Error(`${value} requires a value`);
    flags.set(value.slice(2), next);
    i += 1;
  }
  return flags;
}

function resolvePm2Root() {
  if (process.env.PM2_MODULE_ROOT) return path.resolve(process.env.PM2_MODULE_ROOT);
  const pm2Bin = execFileSync('which', ['pm2'], { encoding: 'utf8', timeout: 10_000 }).trim();
  return path.dirname(path.dirname(fs.realpathSync(pm2Bin)));
}

function readFileEnvironment(runtimeRoot, dotenv) {
  const file = path.join(runtimeRoot, '.env');
  if (!fs.existsSync(file)) return {};
  return dotenv.parse(fs.readFileSync(file));
}

function isSharedKey(key) {
  if (EXCLUDED_SHARED_KEYS.has(key) || key.startsWith('METABOT_RESTART_')) return false;
  return SHARED_KEYS.has(key) || SHARED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function selectSharedEnvironment(source) {
  return Object.fromEntries(Object.entries(source || {}).filter(([key, value]) => (
    value !== undefined && value !== null && String(value).length > 0 && isSharedKey(key)
  )));
}

function currentProcessEnvironment(row) {
  const pm2Env = row.pm2_env || {};
  return pm2Env.env && typeof pm2Env.env === 'object' ? pm2Env.env : pm2Env;
}

function deploymentEnvironment() {
  return Object.fromEntries(DEPLOYMENT_KEYS.map((key) => [key, process.env[key] || '']));
}

function targetEnvironment(Common, target, current, fileEnv, declaredEnv, targetRoot, preferCurrent = false) {
  const mergedAttributes = Common.mergeEnvironmentVariables(target);
  const currentShared = selectSharedEnvironment(currentProcessEnvironment(current));
  const fileShared = selectSharedEnvironment(fileEnv);
  const shared = preferCurrent
    ? { ...declaredEnv, ...fileShared, ...currentShared }
    : { ...declaredEnv, ...currentShared, ...fileShared };
  const env = {
    ...shared,
    ...deploymentEnvironment(),
    METABOT_HOME: targetRoot,
  };
  Object.assign(mergedAttributes, env);
  mergedAttributes.current_conf = { ...(mergedAttributes.current_conf || {}), env };
  return mergedAttributes;
}

function resolveConfiguration({ Common, pm2, dotenv, root, appName, current, preferCurrent }) {
  // Core intentionally remains a separate ecosystem/service. It participates
  // in a cutover only when the CLI has already proved the current checkout
  // owns that PM2 registration.
  const ecosystemPath = path.join(
    root,
    appName === 'metabot-core' ? 'ecosystem.core.config.cjs' : 'ecosystem.config.cjs',
  );
  if (!fs.existsSync(ecosystemPath)) throw new Error(`Missing ecosystem config: ${ecosystemPath}`);
  delete require.cache[require.resolve(ecosystemPath)];
  const ecosystem = require(ecosystemPath);
  const app = (ecosystem.apps || []).find((entry) => entry && entry.name === appName);
  if (!app) throw new Error(`App ${appName} is missing from ${ecosystemPath}`);
  const [verified] = Common.verifyConfs([app]);
  if (!verified) throw new Error(`App ${appName} failed PM2 configuration validation`);
  const target = Common.resolveAppAttributes({ cwd: root, pm2_home: pm2.pm2_home }, verified);
  if (!target.pm_exec_path || !fs.existsSync(target.pm_exec_path)) {
    throw new Error(`App ${appName} target script is missing: ${target.pm_exec_path || '(unresolved)'}`);
  }
  if (!target.env) target.env = {};
  target.env.PM2_HOME = pm2.pm2_home;
  return {
    appName,
    root,
    script: path.resolve(target.pm_exec_path),
    env: targetEnvironment(
      Common,
      target,
      current,
      readFileEnvironment(root, dotenv),
      app.env || {},
      root,
      preferCurrent,
    ),
  };
}

function connect(pm2) {
  return new Promise((resolve, reject) => pm2.connect((error) => error ? reject(error) : resolve()));
}

function list(pm2) {
  return new Promise((resolve, reject) => pm2.list((error, rows) => error ? reject(error) : resolve(rows)));
}

function restartOne(pm2, current, config) {
  return new Promise((resolve, reject) => {
    pm2.Client.executeRemote('restartProcessId', { id: current.pm_id, env: config.env }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function waitForExpected(pm2, config) {
  const deadline = Date.now() + VERIFY_TIMEOUT_MS;
  let last = 'not present';
  while (Date.now() < deadline) {
    const rows = await list(pm2);
    const row = rows.find((entry) => entry.name === config.appName);
    const env = row?.pm2_env;
    last = env?.status || 'not present';
    if (env
      && env.status === 'online'
      && path.resolve(env.pm_cwd || '') === config.root
      && path.resolve(env.pm_exec_path || '') === config.script) {
      return row;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`PM2 app ${config.appName} did not reach the expected runtime (last status: ${last})`);
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const targetRoot = path.resolve(flags.get('runtime') || '');
  const apps = (flags.get('apps') || '').split(',').map((value) => value.trim()).filter(Boolean);
  if (!flags.get('runtime') || apps.length === 0) {
    throw new Error('Usage: pm2-protected-runtime-switch.cjs --runtime DIR --apps app[,app]');
  }
  if (apps.some((app) => !ALLOWED_APPS.has(app)) || new Set(apps).size !== apps.length) {
    throw new Error('Apps must be a unique subset of metabot, metabot-worker-runnerd, metabot-arcd, metabot-core');
  }

  const pm2Root = resolvePm2Root();
  const pkg = require(path.join(pm2Root, 'package.json'));
  const major = Number.parseInt(String(pkg.version || '').split('.')[0], 10);
  if (![5, 6, 7].includes(major)) throw new Error(`Unsupported PM2 version ${pkg.version || 'unknown'}`);
  const pm2 = require(pm2Root);
  const Common = require(path.join(pm2Root, 'lib', 'Common.js'));
  const dotenv = require(require.resolve('dotenv', { paths: [targetRoot, __dirname] }));
  if (typeof pm2.connect !== 'function'
    || typeof pm2.list !== 'function'
    || typeof pm2.Client?.executeRemote !== 'function'
    || typeof Common.verifyConfs !== 'function'
    || typeof Common.resolveAppAttributes !== 'function'
    || typeof Common.mergeEnvironmentVariables !== 'function') {
    throw new Error(`PM2 ${pkg.version || 'unknown'} does not expose the protected restart API`);
  }

  await connect(pm2);
  try {
    const liveRows = await list(pm2);
    const currentByName = new Map();
    for (const appName of apps) {
      const row = liveRows.find((entry) => entry.name === appName);
      if (!row || !Number.isInteger(row.pm_id)) throw new Error(`PM2 app ${appName} is not registered; run metabot start`);
      currentByName.set(appName, row);
    }

    // Resolve every target and rollback configuration before changing any app.
    const targetConfigs = new Map();
    const rollbackConfigs = new Map();
    for (const appName of apps) {
      const current = currentByName.get(appName);
      const currentRoot = path.resolve(current.pm2_env?.pm_cwd || '');
      targetConfigs.set(appName, resolveConfiguration({
        Common, pm2, dotenv, root: targetRoot, appName, current, preferCurrent: false,
      }));
      rollbackConfigs.set(appName, resolveConfiguration({
        Common, pm2, dotenv, root: currentRoot, appName, current, preferCurrent: true,
      }));
    }

    const switched = [];
    try {
      for (const appName of apps) {
        const current = currentByName.get(appName);
        const config = targetConfigs.get(appName);
        // Once PM2 accepts the restart this app may already be running the
        // target even if the subsequent verification fails. Include it in
        // rollback before issuing the state-changing request.
        switched.push(appName);
        await restartOne(pm2, current, config);
        const updated = await waitForExpected(pm2, config);
        currentByName.set(appName, updated);
      }
    } catch (error) {
      const rollbackErrors = [];
      for (const appName of switched.reverse()) {
        try {
          const rows = await list(pm2);
          const current = rows.find((entry) => entry.name === appName);
          if (!current) throw new Error('app disappeared before rollback');
          const rollback = rollbackConfigs.get(appName);
          await restartOne(pm2, current, rollback);
          await waitForExpected(pm2, rollback);
        } catch (rollbackError) {
          rollbackErrors.push(`${appName}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
        }
      }
      const suffix = rollbackErrors.length ? `; rollback failures: ${rollbackErrors.join('; ')}` : '; switched apps rolled back';
      throw new Error(`${error instanceof Error ? error.message : String(error)}${suffix}`);
    }

    const finalRows = await list(pm2);
    const result = apps.map((appName) => {
      const row = finalRows.find((entry) => entry.name === appName);
      return {
        app: appName,
        pid: row?.pid,
        cwd: row?.pm2_env?.pm_cwd,
        script: row?.pm2_env?.pm_exec_path,
      };
    });
    process.stdout.write(`${JSON.stringify({ ok: true, apps: result })}\n`);
  } finally {
    pm2.disconnect();
  }
}

main().catch((error) => {
  process.stderr.write(`pm2 protected switch: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
