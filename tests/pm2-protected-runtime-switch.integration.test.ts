import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PM2_ROOT = process.env.METABOT_PM2_TEST_MODULE_ROOT;
const suite = PM2_ROOT ? describe : describe.skip;
const PM2_TEST_ROOT = PM2_ROOT || '/nonexistent-pm2-test-root';
const APPS = ['metabot-worker-runnerd', 'metabot-arcd', 'metabot'];
const REPO_ROOT = resolve(import.meta.dirname, '..');

suite('protected PM2 runtime switch with an isolated PM2 daemon', () => {
  const root = mkdtempSync(join(tmpdir(), 'metabot-pm2-switch-integration-'));
  const pm2Home = join(root, 'pm2-home');
  const source = join(root, 'source');
  const target = join(root, 'target');
  const pm2Bin = join(PM2_TEST_ROOT, 'bin', 'pm2');
  const env = {
    ...process.env,
    PM2_HOME: pm2Home,
    PM2_MODULE_ROOT: PM2_TEST_ROOT,
    PATH: `${join(PM2_TEST_ROOT, 'bin')}:${process.env.PATH ?? ''}`,
  };

  beforeAll(() => {
    makeRuntime(source, 'source');
    makeRuntime(target, 'target');
    const start = spawnSync(pm2Bin, ['start', join(source, 'ecosystem.config.cjs'), '--update-env'], {
      env, encoding: 'utf8',
    });
    expect(start.status, start.stderr).toBe(0);
  }, 20_000);

  afterAll(() => {
    spawnSync(pm2Bin, ['delete', 'all'], { env, stdio: 'ignore' });
    spawnSync(pm2Bin, ['kill'], { env, stdio: 'ignore' });
  });

  it('keeps all PM2 registrations present while changing cwd/script/env in place', () => {
    const before = readApps();
    expect(before.map((row) => row.name)).toEqual(expect.arrayContaining(APPS));
    const ids = Object.fromEntries(before.map((row) => [row.name, row.pm_id]));

    const output = execFileSync(process.execPath, [
      join(REPO_ROOT, 'scripts', 'pm2-protected-runtime-switch.cjs'),
      '--runtime', target,
      '--apps', APPS.join(','),
    ], { env, encoding: 'utf8', timeout: 20_000 });
    expect(JSON.parse(output).ok).toBe(true);

    const after = readApps();
    expect(after).toHaveLength(3);
    for (const row of after) {
      expect(row.pm_id).toBe(ids[row.name]);
      expect(row.pm2_env.status).toBe('online');
      expect(row.pm2_env.pm_cwd).toBe(target);
      expect(row.pm2_env.pm_exec_path).toBe(join(target, `${row.name}.cjs`));
      expect(row.pm2_env.RUNTIME_LABEL).toBe('target');
      expect(row.pm2_env.HTTP_PROXY).toBe('http://source-proxy.invalid:8080');
      expect(row.pm2_env.http_proxy).toBe('http://source-proxy.invalid:8080');
      expect(row.pm2_env.NO_PROXY).toBe('source.internal');
      expect(row.pm2_env.no_proxy).toBe('source.internal');
      expect(row.pm2_env.METABOT_HOME).toBe(target);
    }
  }, 20_000);

  function readApps(): Array<any> {
    const output = execFileSync(pm2Bin, ['jlist'], { env, encoding: 'utf8', timeout: 10_000 });
    return JSON.parse(output).filter((row: { name?: string }) => APPS.includes(row.name || ''));
  }
});

function makeRuntime(root: string, label: string): void {
  mkdirSync(root, { recursive: true });
  for (const app of APPS) {
    writeFileSync(join(root, `${app}.cjs`), 'setInterval(() => {}, 1000);\n');
  }
  writeFileSync(join(root, 'ecosystem.config.cjs'), `module.exports=${JSON.stringify({
    apps: APPS.map((app) => ({
      name: app,
      cwd: root,
      script: `${app}.cjs`,
      env: {
        RUNTIME_LABEL: label,
        ...(label === 'source' ? {
          HTTP_PROXY: 'http://source-proxy.invalid:8080',
          http_proxy: 'http://source-proxy.invalid:8080',
          NO_PROXY: 'source.internal',
          no_proxy: 'source.internal',
        } : {}),
      },
    })),
  })};\n`);
}
