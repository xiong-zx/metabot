import { chmodSync, cpSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const runIntegration = process.env.METABOT_RUN_PM2_INTEGRATION === '1';
const suite = runIntegration ? describe : describe.skip;

suite('PM2 atomic runtime switching (isolated PM2_HOME)', () => {
  const root = mkdtempSync(join(tmpdir(), 'metabot-pm2-atomic-'));
  const pm2Home = join(root, 'pm2-home');
  const appName = 'metabot-atomic-test';
  const runtimeA = join(root, 'runtime-a');
  const runtimeB = join(root, 'runtime-b');
  const switchHelper = join(runtimeB, 'scripts', 'pm2-atomic-runtime-switch.cjs');
  const env = {
    ...process.env,
    PM2_HOME: pm2Home,
    BOTS_CONFIG: '/shared/bots.json',
    METABOT_DEFAULT_ENV_FILE: '/shared/default.env',
    WIKI_SYNC_STATE_DIR: '/shared/wiki-state',
    FEISHU_SERVICE_APP_ID: 'shared-app',
  };
  delete env.METABOT_RESTART_REQUEST_ID;

  beforeAll(() => {
    mkdirSync(runtimeA, { recursive: true });
    mkdirSync(runtimeB, { recursive: true });
    mkdirSync(join(runtimeB, 'scripts'), { recursive: true });
    cpSync(join(import.meta.dirname, '..', 'scripts', 'pm2-atomic-runtime-switch.cjs'), switchHelper);
    for (const [runtime, label] of [[runtimeA, 'A'], [runtimeB, 'B']] as const) {
      const script = join(runtime, 'app.cjs');
      writeFileSync(script, 'setInterval(() => {}, 1000);\n');
      chmodSync(script, 0o755);
      writeFileSync(join(runtime, 'ecosystem.config.cjs'), `module.exports={apps:[{
        name:${JSON.stringify(appName)},
        script:${JSON.stringify(script)},
        cwd:${JSON.stringify(runtime)},
        env:{
          RUNTIME_LABEL:${JSON.stringify(label)},
          HTTP_PROXY:'http://127.0.0.1:7890',
          HTTPS_PROXY:'http://127.0.0.1:7890',
          ${label === 'A' ? "BOTS_CONFIG:'/shared/bots.json',METABOT_DEFAULT_ENV_FILE:'/shared/default.env',WIKI_SYNC_STATE_DIR:'/shared/wiki-state',FEISHU_SERVICE_APP_ID:'shared-app'," : ""}
          ${label === 'A' ? "METABOT_HOME:'/old/runtime',METABOT_RESTART_REQUEST_ID:'old-request'" : `METABOT_HOME:${JSON.stringify(runtime)}`}
        }
      }]};\n`);
    }
  });

  afterAll(() => {
    spawnSync('pm2', ['delete', 'all'], { env, stdio: 'ignore' });
    spawnSync('pm2', ['kill'], { env, stdio: 'ignore' });
  });

  it('updates cwd, script, and proxy env without removing the PM2 app entry', async () => {
    const started = spawnSync('pm2', ['start', join(runtimeA, 'ecosystem.config.cjs'), '--only', appName], {
      env,
      encoding: 'utf8',
    });
    expect(started.status, started.stderr).toBe(0);
    expect(readApp()).toMatchObject({
      status: 'online',
      cwd: runtimeA,
      script: join(runtimeA, 'app.cjs'),
      runtime: 'A',
    });

    let missingSamples = 0;
    let samples = 0;
    const switchPromise = runCommand(process.execPath, [switchHelper, runtimeB, appName]);
    let switching = true;
    while (switching) {
      samples += 1;
      if (!readApp()) missingSamples += 1;
      switching = !switchPromise.done();
      if (switching) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const switched = await switchPromise.result;
    expect(switched.code, switched.stderr).toBe(0);
    expect(samples).toBeGreaterThan(0);
    expect(missingSamples).toBe(0);
    expect(readApp()).toMatchObject({
      status: 'online',
      cwd: runtimeB,
      script: join(runtimeB, 'app.cjs'),
      runtime: 'B',
      httpProxy: 'http://127.0.0.1:7890',
      httpsProxy: 'http://127.0.0.1:7890',
      botsConfig: '/shared/bots.json',
      defaultEnvFile: '/shared/default.env',
      wikiSyncStateDir: '/shared/wiki-state',
      serviceAppId: 'shared-app',
      metabotHome: runtimeB,
      restartRequestId: '',
    });
  }, 20_000);

  it('keeps the current app online when a new ecosystem is rejected', () => {
    const invalidRuntime = join(root, 'invalid-runtime');
    mkdirSync(invalidRuntime, { recursive: true });
    writeFileSync(join(invalidRuntime, 'ecosystem.config.cjs'), 'throw new Error("invalid deployment config");\n');
    const failed = spawnSync(process.execPath, [switchHelper, invalidRuntime, appName], {
      env,
      encoding: 'utf8',
    });
    expect(failed.status).not.toBe(0);
    expect(readApp()).toMatchObject({ status: 'online', cwd: runtimeB, runtime: 'B' });
  });

  function readApp(): Record<string, unknown> | undefined {
    const result = spawnSync('pm2', ['jlist'], { env, encoding: 'utf8' });
    if (result.status !== 0) return undefined;
    const rows = JSON.parse(result.stdout || '[]');
    const app = rows.find((row: { name?: string }) => row.name === appName);
    if (!app) return undefined;
    const pm2Env = app.pm2_env || {};
    return {
      status: pm2Env.status,
      cwd: pm2Env.pm_cwd,
      script: pm2Env.pm_exec_path,
      runtime: pm2Env.RUNTIME_LABEL,
      httpProxy: pm2Env.HTTP_PROXY,
      httpsProxy: pm2Env.HTTPS_PROXY,
      botsConfig: pm2Env.BOTS_CONFIG,
      defaultEnvFile: pm2Env.METABOT_DEFAULT_ENV_FILE,
      wikiSyncStateDir: pm2Env.WIKI_SYNC_STATE_DIR,
      serviceAppId: pm2Env.FEISHU_SERVICE_APP_ID,
      metabotHome: pm2Env.METABOT_HOME,
      restartRequestId: pm2Env.METABOT_RESTART_REQUEST_ID,
    };
  }

  function runCommand(command: string, args: string[]) {
    let settled = false;
    const result = new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += String(chunk); });
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.once('error', reject);
      child.once('close', (code) => {
        settled = true;
        resolve({ code: code ?? 1, stdout, stderr });
      });
    });
    return { done: () => settled, result };
  }
});
