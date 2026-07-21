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
    || typeof Common.resolveAppAttributes !== 'function'
    || typeof Common.mergeEnvironmentVariables !== 'function') {
    throw new Error(`PM2 ${pkg.version || 'unknown'} does not expose the required atomic restart API`);
  }
  const ecosystemPath = path.join(targetRoot, 'ecosystem.config.cjs');
  delete require.cache[require.resolve(ecosystemPath)];
  const ecosystem = require(ecosystemPath);
  const app = (ecosystem.apps || []).find((entry) => entry && entry.name === appName);
  if (!app) throw new Error(`App ${appName} is missing from ${ecosystemPath}`);
  target = Common.resolveAppAttributes({ cwd: targetRoot, pm2_home: pm2.pm2_home }, app);
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
