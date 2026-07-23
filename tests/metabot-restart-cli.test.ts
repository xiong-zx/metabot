import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '..');
const metabotBin = join(repoRoot, 'bin', 'metabot');

function makeFakePm2(dir: string): string {
  const binDir = join(dir, 'bin');
  const file = join(binDir, 'pm2');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `#!/usr/bin/env bash
set -e
if [[ "\${1:-}" == "jlist" ]]; then
  printf '[{"name":"metabot","pid":999999,"pm2_env":{"status":"online","pm_cwd":"%s","pm_exec_path":"%s/src/index.ts"}}]\\n' "\${FAKE_PM2_CWD}" "\${FAKE_PM2_CWD}"
  exit 0
fi
printf '%s\\n' "$*" >> "\${FAKE_PM2_LOG}"
exit "\${FAKE_PM2_EXIT:-0}"
`);
  chmodSync(file, 0o755);
  const curl = join(binDir, 'curl');
  writeFileSync(curl, '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(curl, 0o755);
  return binDir;
}

describe('metabot controlled restart CLI', () => {
  it('issues one atomic restart for a requestId and deduplicates repeats', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-restart-cli-'));
    const fakeBin = makeFakePm2(dir);
    const logFile = join(dir, 'pm2.log');
    const stateDir = join(dir, 'state');
    const env = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      HOME: dir,
      METABOT_HOME: repoRoot,
      SESSION_STORE_DIR: stateDir,
      FAKE_PM2_CWD: repoRoot,
      FAKE_PM2_LOG: logFile,
    };

    const first = spawnSync('bash', [metabotBin, 'restart', '--request-id', 'restart-dedupe-1', '--json'], {
      env,
      encoding: 'utf8',
    });
    const second = spawnSync('bash', [metabotBin, 'restart', '--request-id', 'restart-dedupe-1', '--json'], {
      env,
      encoding: 'utf8',
    });

    expect(first.status, first.stderr).toBe(0);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain('"duplicate":true');
    const commands = readFileSync(logFile, 'utf8').trim().split('\n');
    expect(commands).toEqual(['restart metabot --update-env']);
    expect(commands.join('\n')).not.toContain('delete');
    expect(commands.join('\n')).not.toContain('save');
    const state = JSON.parse(readFileSync(join(stateDir, 'restart-requests.json'), 'utf8'));
    expect(state).toEqual([
      expect.objectContaining({
        requestId: 'restart-dedupe-1',
        status: 'restarting',
        attemptCount: 1,
        targetCwd: repoRoot,
        targetScript: join(repoRoot, 'src', 'index.ts'),
      }),
    ]);
    expect(JSON.parse(readFileSync(join(stateDir, 'last-restart.json'), 'utf8'))).toMatchObject({
      requestId: 'restart-dedupe-1',
    });
  });

  it('fails closed when restart is asked to switch the live runtime', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-restart-cli-'));
    const fakeBin = makeFakePm2(dir);
    const logFile = join(dir, 'pm2.log');
    const result = spawnSync('bash', [metabotBin, 'restart', '--request-id', 'restart-wrong-runtime'], {
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        HOME: dir,
        METABOT_HOME: repoRoot,
        SESSION_STORE_DIR: join(dir, 'state'),
        FAKE_PM2_CWD: '/srv/other-metabot',
        FAKE_PM2_LOG: logFile,
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toContain('Refusing to switch the live runtime');
    expect(result.stdout).toContain('deploy-runtime');
    expect(() => readFileSync(logFile, 'utf8')).toThrow();
  });

  it('loads proxy variables and the runtime root into the PM2 ecosystem contract', () => {
    const result = spawnSync(
      process.execPath,
      ['-e', 'const c=require(process.argv[1]); console.log(JSON.stringify(c.apps[0].env))', join(repoRoot, 'ecosystem.config.cjs')],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          HTTP_PROXY: 'http://proxy.test:8080',
          HTTPS_PROXY: 'http://secure-proxy.test:8443',
          NO_PROXY: 'internal.test',
        },
        encoding: 'utf8',
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const env = JSON.parse(result.stdout.trim().split('\n').at(-1) || '{}');
    expect(env).toMatchObject({
      METABOT_HOME: repoRoot,
      HTTP_PROXY: 'http://proxy.test:8080',
      http_proxy: 'http://proxy.test:8080',
      HTTPS_PROXY: 'http://secure-proxy.test:8443',
      https_proxy: 'http://secure-proxy.test:8443',
    });
    expect(env.NO_PROXY.split(',')).toEqual(expect.arrayContaining(['internal.test', 'localhost', '127.0.0.1']));
  });

  it('deduplicates external runtime deployment by caller-provided requestId', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-deploy-cli-'));
    const fakeBin = makeFakePm2(dir);
    const runtime = join(dir, 'runtime');
    const stateDir = join(dir, 'state');
    const switchLog = join(dir, 'switch.log');
    mkdirSync(join(runtime, 'scripts'), { recursive: true });
    writeFileSync(join(runtime, 'ecosystem.config.cjs'), 'module.exports={apps:[{name:"metabot",script:"src/index.ts"}]};\n');
    writeFileSync(join(runtime, 'scripts', 'pm2-atomic-runtime-switch.cjs'), `
const fs=require('node:fs');
const path=require('node:path');
const state=path.join(process.env.SESSION_STORE_DIR,'restart-requests.json');
const rows=JSON.parse(fs.readFileSync(state,'utf8'));
const row=rows.find((entry)=>entry.requestId===process.env.METABOT_RESTART_REQUEST_ID);
row.status='healthy';
row.healthyAt=Date.now();
fs.writeFileSync(state,JSON.stringify(rows));
fs.appendFileSync(process.env.FAKE_SWITCH_LOG,'switch\\n');
`);
    const env = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      HOME: dir,
      SESSION_STORE_DIR: stateDir,
      FAKE_PM2_CWD: repoRoot,
      FAKE_PM2_LOG: join(dir, 'pm2.log'),
      FAKE_SWITCH_LOG: switchLog,
    };
    const args = [
      metabotBin,
      'deploy-runtime',
      '--runtime', runtime,
      '--request-id', 'deploy-dedupe-1',
      '--timeout', '2',
      '--json',
    ];

    const first = spawnSync('bash', args, { env, encoding: 'utf8' });
    const second = spawnSync('bash', args, { env, encoding: 'utf8' });

    expect(first.status, first.stderr).toBe(0);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain('"duplicate":true');
    expect(readFileSync(switchLog, 'utf8')).toBe('switch\n');
  });
});
