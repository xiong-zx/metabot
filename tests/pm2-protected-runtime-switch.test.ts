import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const HELPER = join(REPO_ROOT, 'scripts', 'pm2-protected-runtime-switch.cjs');
const APPS = ['metabot-worker-runnerd', 'metabot-arcd', 'metabot'];
const CORE_APP = 'metabot-core';

function makeHarness(pm2Version = '7.0.3') {
  const root = mkdtempSync(join(tmpdir(), 'metabot-pm2-switch-fake-'));
  const source = join(root, 'source');
  const target = join(root, 'target');
  const pm2Root = join(root, 'fake-pm2');
  const stateFile = join(root, 'pm2-state.json');
  makeRuntime(source, 'source');
  makeRuntime(target, 'target');
  mkdirSync(join(pm2Root, 'lib'), { recursive: true });
  writeFileSync(join(pm2Root, 'package.json'), `${JSON.stringify({
    name: 'pm2', version: pm2Version, main: 'index.js',
  })}\n`);
  writeFileSync(join(pm2Root, 'index.js'), `
const fs = require('node:fs');
const stateFile = process.env.FAKE_PM2_STATE;
function read(){ return JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
function write(rows){ fs.writeFileSync(stateFile, JSON.stringify(rows)); }
module.exports = {
  pm2_home: process.env.PM2_HOME,
  connect(callback){ callback(); },
  disconnect(){},
  list(callback){ callback(null, read()); },
  Client: { executeRemote(_name, payload, callback){
    const rows = read();
    const row = rows.find((entry) => entry.pm_id === payload.id);
    const conf = payload.env;
    const env = conf.current_conf?.env || conf.env || conf;
    row.pid += 100;
    row.pm2_env = { ...env, status: 'online', pm_cwd: conf.pm_cwd, pm_exec_path: conf.pm_exec_path, exec_interpreter: conf.exec_interpreter, node_args: conf.node_args };
    write(rows);
    callback(env.FAKE_SWITCH_FAILURE === 'true' ? new Error('injected restart failure') : null);
  }},
};
`);
  writeFileSync(join(pm2Root, 'lib', 'Common.js'), `
const path = require('node:path');
exports.verifyConfs = (apps) => apps;
exports.resolveAppAttributes = ({ cwd }, app) => ({
  ...app,
  pm_cwd: path.resolve(cwd, app.cwd || '.'),
  pm_exec_path: path.resolve(cwd, app.script),
  env: { ...(app.env || {}) },
});
exports.mergeEnvironmentVariables = (target) => ({
  ...target,
  current_conf: { ...(target.current_conf || {}), env: { ...(target.env || {}) } },
});
`);
  writeState(stateFile, source);
  return {
    root, source, target, pm2Root, stateFile,
    env: {
      ...process.env,
      PM2_HOME: join(root, 'pm2-home'),
      PM2_MODULE_ROOT: pm2Root,
      FAKE_PM2_STATE: stateFile,
      METABOT_RESTART_REQUEST_ID: 'deploy-test',
      METABOT_RESTART_SOURCE: 'test',
      METABOT_RESTART_REASON: 'verify switch',
      METABOT_RESTART_RESUME: 'true',
    },
  };
}

function makeRuntime(root: string, label: string): void {
  mkdirSync(root, { recursive: true });
  for (const app of APPS) writeFileSync(join(root, `${app}.cjs`), 'setInterval(() => {}, 1000);\n');
  writeFileSync(join(root, `${CORE_APP}.cjs`), 'setInterval(() => {}, 1000);\n');
  const apps = APPS.map((app) => ({
    name: app,
    script: `${app}.cjs`,
    cwd: root,
    interpreter: 'node',
    interpreter_args: label === 'source' ? '--no-warnings' : '--trace-warnings',
    env: {
      RUNTIME_LABEL: label,
      ...(app === 'metabot-arcd' ? {
        METABOT_ARC_RELEASE_ROOT: join(root, 'official', 'autoresearchclaw'),
      } : {}),
      ...(label === 'source' ? {
        HTTP_PROXY: 'http://source-proxy.invalid:8080',
        http_proxy: 'http://source-proxy.invalid:8080',
        NO_PROXY: 'source.internal',
        no_proxy: 'source.internal',
        SESSION_STORE_DIR: '/var/lib/metabot-state',
        API_SECRET: 'must-not-be-printed',
      } : { TARGET_ONLY: 'yes' }),
    },
  }));
  writeFileSync(join(root, 'ecosystem.config.cjs'), `module.exports=${JSON.stringify({ apps })};\n`);
  writeFileSync(join(root, 'ecosystem.core.config.cjs'), `module.exports=${JSON.stringify({
    apps: [{
      name: CORE_APP,
      script: `${CORE_APP}.cjs`,
      cwd: root,
      env: { RUNTIME_LABEL: label, METABOT_CORE_DATA_DIR: '/var/lib/metabot-core' },
    }],
  })};\n`);
}

function writeState(file: string, runtime: string): void {
  writeFileSync(file, JSON.stringify(APPS.map((app, index) => ({
    name: app,
    pm_id: index,
    pid: 1000 + index,
    pm2_env: {
      status: 'online',
      pm_cwd: runtime,
      pm_exec_path: join(runtime, `${app}.cjs`),
      RUNTIME_LABEL: 'source',
      HTTP_PROXY: 'http://source-proxy.invalid:8080',
      http_proxy: 'http://source-proxy.invalid:8080',
      NO_PROXY: 'source.internal',
      no_proxy: 'source.internal',
      SESSION_STORE_DIR: '/var/lib/metabot-state',
      API_SECRET: 'must-not-be-printed',
      ...(app === 'metabot-arcd' ? {
        METABOT_ARC_RELEASE_ROOT: join(runtime, 'official', 'autoresearchclaw'),
      } : {}),
    },
  }))));
}

describe('protected PM2 runtime switch helper', () => {
  it('changes all three registered apps in place and preserves shared/proxy environment', () => {
    const kit = makeHarness();
    const stdout = execFileSync(process.execPath, [
      HELPER, '--runtime', kit.target, '--apps', APPS.join(','),
    ], { env: kit.env, encoding: 'utf8' });
    const result = JSON.parse(stdout);
    expect(result.apps.map((entry: { app: string }) => entry.app)).toEqual(APPS);
    expect(stdout).not.toContain('must-not-be-printed');
    expect(result.expectations.metabot).toMatchObject({
      cwd: kit.target,
      script: join(kit.target, 'metabot.cjs'),
      interpreter: 'node',
      interpreterArgs: ['--trace-warnings'],
    });
    expect(result.expectations.metabot.envHashes.API_SECRET).toMatch(/^[a-f0-9]{64}$/);

    const rows = JSON.parse(readFileSync(kit.stateFile, 'utf8'));
    expect(rows).toHaveLength(3);
    for (const [index, row] of rows.entries()) {
      expect(row).toMatchObject({ name: APPS[index], pm_id: index });
      expect(row.pm2_env).toMatchObject({
        status: 'online',
        pm_cwd: kit.target,
        pm_exec_path: join(kit.target, `${APPS[index]}.cjs`),
        RUNTIME_LABEL: 'target',
        TARGET_ONLY: 'yes',
        HTTP_PROXY: 'http://source-proxy.invalid:8080',
        http_proxy: 'http://source-proxy.invalid:8080',
        NO_PROXY: 'source.internal',
        no_proxy: 'source.internal',
        SESSION_STORE_DIR: '/var/lib/metabot-state',
        METABOT_HOME: kit.target,
        exec_interpreter: 'node',
        node_args: ['--trace-warnings'],
      });
    }
    const arc = rows.find((row: { name: string }) => row.name === 'metabot-arcd');
    expect(arc.pm2_env.METABOT_ARC_RELEASE_ROOT).toBe(
      join(kit.source, 'official', 'autoresearchclaw'),
    );
  });

  it('plans secret-safe expectations without changing PM2 state', () => {
    const kit = makeHarness();
    const before = readFileSync(kit.stateFile, 'utf8');
    const stdout = execFileSync(process.execPath, [
      HELPER, '--runtime', kit.target, '--apps', APPS.join(','), '--plan-only', 'true',
    ], { env: kit.env, encoding: 'utf8' });
    const plan = JSON.parse(stdout);
    expect(plan.metabot.envHashes.API_SECRET).toMatch(/^[a-f0-9]{64}$/);
    expect(stdout).not.toContain('must-not-be-printed');
    expect(readFileSync(kit.stateFile, 'utf8')).toBe(before);
  });

  it('rolls back the failing app and every earlier switched app without deleting entries', () => {
    const kit = makeHarness();
    const ecosystemPath = join(kit.target, 'ecosystem.config.cjs');
    const ecosystem = JSON.parse(readFileSync(ecosystemPath, 'utf8').replace(/^module\.exports=/, '').replace(/;\n$/, ''));
    ecosystem.apps[1].env.FAKE_SWITCH_FAILURE = 'true';
    writeFileSync(ecosystemPath, `module.exports=${JSON.stringify(ecosystem)};\n`);

    const failed = spawnSync(process.execPath, [
      HELPER, '--runtime', kit.target, '--apps', APPS.join(','),
    ], { env: kit.env, encoding: 'utf8' });
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain('switched apps rolled back');
    expect(failed.stderr).not.toContain('must-not-be-printed');
    const rows = JSON.parse(readFileSync(kit.stateFile, 'utf8'));
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.pm2_env.status).toBe('online');
      expect(row.pm2_env.pm_cwd).toBe(kit.source);
      expect(row.pm2_env.pm_exec_path).toBe(join(kit.source, `${row.name}.cjs`));
      expect(row.pm2_env.RUNTIME_LABEL).toBe('source');
    }
  });

  it('uses the separate Core ecosystem when an ownership-checked caller includes local Core', () => {
    const kit = makeHarness();
    const rows = JSON.parse(readFileSync(kit.stateFile, 'utf8'));
    rows.push({
      name: CORE_APP,
      pm_id: 3,
      pid: 1003,
      pm2_env: {
        status: 'online',
        pm_cwd: kit.source,
        pm_exec_path: join(kit.source, `${CORE_APP}.cjs`),
        RUNTIME_LABEL: 'source',
        METABOT_CORE_DATA_DIR: '/var/lib/metabot-core',
      },
    });
    writeFileSync(kit.stateFile, JSON.stringify(rows));

    execFileSync(process.execPath, [
      HELPER, '--runtime', kit.target, '--apps', `${CORE_APP},metabot`,
    ], { env: kit.env, encoding: 'utf8' });
    const switched = JSON.parse(readFileSync(kit.stateFile, 'utf8'));
    const core = switched.find((row: { name: string }) => row.name === CORE_APP);
    expect(core).toMatchObject({ name: CORE_APP, pm_id: 3 });
    expect(core.pm2_env).toMatchObject({
      status: 'online',
      pm_cwd: kit.target,
      pm_exec_path: join(kit.target, `${CORE_APP}.cjs`),
      RUNTIME_LABEL: 'target',
      METABOT_CORE_DATA_DIR: '/var/lib/metabot-core',
      METABOT_HOME: kit.target,
    });
  });

  it('rejects an unreviewed PM2 major version', () => {
    const kit = makeHarness('8.0.0');
    const failed = spawnSync(process.execPath, [
      HELPER, '--runtime', kit.target, '--apps', APPS.join(','),
    ], { env: kit.env, encoding: 'utf8' });
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain('Unsupported PM2 version 8.0.0');
  });
});
