import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fixture(): { runtime: string; bin: string; log: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), 'metabot-daemon-lifecycle-'));
  const runtime = join(root, 'runtime');
  const fakeBin = join(root, 'fake-bin');
  const log = join(root, 'pm2.log');
  for (const path of [
    'bin',
    'src/services',
    'src/runtime',
    'scripts',
    'packages/worker-runner-mcp/dist',
    'packages/arc-mcp/dist',
    'packages/arc-worker-runner-adapter/dist',
    'node_modules',
  ]) mkdirSync(join(runtime, path), { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  cpSync(join(REPO_ROOT, 'bin/metabot'), join(runtime, 'bin/metabot'));
  chmodSync(join(runtime, 'bin/metabot'), 0o755);
  for (const path of [
    'src/index.ts',
    'src/runtime/restart-state-cli.ts',
    'scripts/pm2-protected-runtime-switch.cjs',
    'src/services/local-daemon-health.ts',
    'packages/worker-runner-mcp/dist/daemon-cli.js',
    'packages/arc-mcp/dist/daemon-cli.js',
    'packages/arc-worker-runner-adapter/dist/factory.js',
    'ecosystem.config.cjs',
  ]) writeFileSync(join(runtime, path), '// fixture\n');
  symlinkSync(join(REPO_ROOT, 'node_modules/tsx'), join(runtime, 'node_modules/tsx'));
  symlinkSync(join(REPO_ROOT, 'node_modules/better-sqlite3'), join(runtime, 'node_modules/better-sqlite3'));
  const switchHelper = join(root, 'protected-switch.cjs');
  writeFileSync(switchHelper, [
    "const fs = require('node:fs');",
    "fs.appendFileSync(process.env.PM2_LOG, `protected-switch ${process.argv.slice(2).join(' ')}\\n`);",
    "process.stdout.write(JSON.stringify({ ok: true }) + '\\n');",
  ].join('\n'));
  writeExecutable(join(fakeBin, 'pm2'), [
    '#!/usr/bin/env bash',
    'printf "%s\\n" "$*" >> "$PM2_LOG"',
    'if [[ "${1:-}" == "jlist" ]]; then',
    '  printf \'[{"name":"metabot","pid":101,"pm2_env":{"status":"online","pm_cwd":"%s","pm_exec_path":"%s/src/index.ts"}},{"name":"metabot-worker-runnerd","pid":102,"pm2_env":{"status":"online","pm_cwd":"%s","pm_exec_path":"%s/packages/worker-runner-mcp/dist/daemon-cli.js"}},{"name":"metabot-arcd","pid":103,"pm2_env":{"status":"online","pm_cwd":"%s","pm_exec_path":"%s/packages/arc-mcp/dist/daemon-cli.js"}}]\\n\' "$FAKE_RUNTIME" "$FAKE_RUNTIME" "$FAKE_RUNTIME" "$FAKE_RUNTIME" "$FAKE_RUNTIME" "$FAKE_RUNTIME"',
    'fi',
  ]);
  writeExecutable(join(fakeBin, 'node'), [
    '#!/usr/bin/env bash',
    'if [[ "$*" == *"--busy ${FAKE_BUSY_DAEMON:-__none__}"* ]]; then exit 10; fi',
    'if [[ "$*" == *"local-daemon-health.ts"* ]]; then exit 0; fi',
    'exec "$REAL_NODE" "$@"',
  ]);
  writeExecutable(join(fakeBin, 'curl'), ['#!/usr/bin/env bash', 'exit 0']);
  return {
    runtime,
    bin: join(runtime, 'bin/metabot'),
    log,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      METABOT_HOME: runtime,
      METABOT_RESTART_STATE_ROOT: REPO_ROOT,
      METABOT_PROTECTED_SWITCH_HELPER: switchHelper,
      SESSION_STORE_DIR: join(root, 'state'),
      PM2_LOG: log,
      FAKE_RUNTIME: runtime,
      REAL_NODE: process.execPath,
      HOME: join(root, 'home'),
    },
  };
}

function writeExecutable(path: string, lines: string[]): void {
  writeFileSync(path, `${lines.join('\n')}\n`, { mode: 0o755 });
}

function run(kit: ReturnType<typeof fixture>, args: string[], extraEnv: NodeJS.ProcessEnv = {}): string {
  try {
    return execFileSync('bash', [kit.bin, ...args], {
      env: { ...kit.env, ...extraEnv },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const result = error as Error & { stdout?: string; stderr?: string };
    throw new Error(`${result.message}\nstdout:\n${result.stdout || ''}\nstderr:\n${result.stderr || ''}`, { cause: error });
  }
}

describe('metabot execution-daemon lifecycle', () => {
  it('keeps ordinary restart Bridge-only', () => {
    const kit = fixture();
    run(kit, ['restart']);
    const log = readFileSync(kit.log, 'utf8');
    expect(log).toContain(`protected-switch --runtime ${kit.runtime} --apps metabot`);
    expect(log).not.toContain('restart metabot-worker-runnerd');
    expect(log).not.toContain('delete ');
    expect(log).not.toContain('save --force');
  });

  it('deduplicates a caller-provided requestId before a second PM2 action', () => {
    const kit = fixture();
    run(kit, ['restart', '--request-id', 'restart-dedupe-1', '--json']);
    const duplicate = run(kit, ['restart', '--request-id', 'restart-dedupe-1', '--json']);
    expect(duplicate).toContain('"duplicate":true');
    const switches = readFileSync(kit.log, 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('protected-switch '));
    expect(switches).toHaveLength(1);
  });

  it('refuses a busy daemon restart and allows an explicit forced recovery transition', () => {
    const kit = fixture();
    expect(() => run(kit, ['restart', '--daemon', 'worker'], { FAKE_BUSY_DAEMON: 'worker' })).toThrow();
    expect(readFileSync(kit.log, 'utf8')).not.toContain('restart metabot-worker-runnerd');

    const output = run(kit, ['restart', '--daemon', 'worker', '--force'], { FAKE_BUSY_DAEMON: 'worker' });
    expect(output).toContain('recovery_required');
    expect(readFileSync(kit.log, 'utf8')).toContain('restart metabot-worker-runnerd --update-env');
    expect(readFileSync(kit.log, 'utf8')).toContain('save --force');
  });

  it('starts and stops the whole sibling-app ecosystem', () => {
    const kit = fixture();
    run(kit, ['start']);
    run(kit, ['stop']);
    const log = readFileSync(kit.log, 'utf8');
    expect(log).toContain(`start ${kit.runtime}/ecosystem.config.cjs --update-env`);
    expect(log).toContain('save --force');
    expect(log).toContain('stop metabot\n');
    expect(log).toContain('stop metabot-worker-runnerd\n');
    expect(log).toContain('stop metabot-arcd\n');
  });

  it('deploy-runtime switches all sibling apps without delete/start/save in the old process', () => {
    const current = fixture();
    const target = fixture();
    run(current, ['deploy-runtime', '--runtime', target.runtime, '--no-wait']);
    const log = readFileSync(current.log, 'utf8');
    expect(log).toContain(`protected-switch --runtime ${target.runtime} --apps metabot-worker-runnerd,metabot-arcd,metabot`);
    expect(log).not.toContain('delete ');
    expect(log).not.toContain('start ');
    expect(log).not.toContain('save --force');
  });

  it('uses wire-only health code and builds every daemon workspace on update', () => {
    const health = readFileSync(join(REPO_ROOT, 'src/services/local-daemon-health.ts'), 'utf8');
    const cli = readFileSync(join(REPO_ROOT, 'bin/metabot'), 'utf8');
    const uninstall = readFileSync(join(REPO_ROOT, 'uninstall.sh'), 'utf8');
    const production = readFileSync(join(REPO_ROOT, 'docs/deployment/production.md'), 'utf8');
    expect(health).toContain('StreamableHTTPClientTransport');
    expect(health).toContain("name: 'worker_list'");
    expect(health).toContain("name: 'arc_run_list'");
    expect(health).not.toMatch(/@xvirobotics\/(?:worker-runner-mcp|arc-mcp|arc-worker-runner-adapter)/);
    for (const workspace of ['worker-runner-mcp', 'arc-mcp', 'arc-worker-runner-adapter']) {
      expect(cli).toContain(`npm run build -w @xvirobotics/${workspace}`);
    }
    expect(uninstall).toContain('for app in metabot metabot-worker-runnerd metabot-arcd');
    expect(production).toContain('pm2 delete metabot-worker-runnerd metabot-arcd');
  });
});
