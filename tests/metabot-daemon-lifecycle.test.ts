import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
    'packages/worker-runner-mcp/dist',
    'packages/arc-mcp/dist',
    'packages/arc-worker-runner-adapter/dist',
    'node_modules/tsx',
  ]) mkdirSync(join(runtime, path), { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  cpSync(join(REPO_ROOT, 'bin/metabot'), join(runtime, 'bin/metabot'));
  chmodSync(join(runtime, 'bin/metabot'), 0o755);
  for (const path of [
    'src/services/local-daemon-health.ts',
    'packages/worker-runner-mcp/dist/daemon-cli.js',
    'packages/arc-mcp/dist/daemon-cli.js',
    'packages/arc-worker-runner-adapter/dist/factory.js',
    'ecosystem.config.cjs',
  ]) writeFileSync(join(runtime, path), '// fixture\n');
  writeFileSync(join(runtime, 'node_modules/tsx/package.json'), '{"name":"tsx"}\n');
  writeExecutable(join(fakeBin, 'pm2'), [
    '#!/usr/bin/env bash',
    'printf "%s\\n" "$*" >> "$PM2_LOG"',
    'if [[ "${1:-}" == "jlist" ]]; then printf "[]\\n"; fi',
  ]);
  writeExecutable(join(fakeBin, 'node'), [
    '#!/usr/bin/env bash',
    'if [[ "$*" == *"--busy ${FAKE_BUSY_DAEMON:-__none__}"* ]]; then exit 10; fi',
    'exit 0',
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
      PM2_LOG: log,
      HOME: join(root, 'home'),
    },
  };
}

function writeExecutable(path: string, lines: string[]): void {
  writeFileSync(path, `${lines.join('\n')}\n`, { mode: 0o755 });
}

function run(kit: ReturnType<typeof fixture>, args: string[], extraEnv: NodeJS.ProcessEnv = {}): string {
  return execFileSync('bash', [kit.bin, ...args], {
    env: { ...kit.env, ...extraEnv },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('metabot execution-daemon lifecycle', () => {
  it('keeps ordinary restart Bridge-only', () => {
    const kit = fixture();
    run(kit, ['restart']);
    expect(readFileSync(kit.log, 'utf8')).toBe('restart metabot\n');
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

  it('deploy-runtime replaces all old-runtime apps from an external controller', () => {
    const current = fixture();
    const target = fixture();
    run(current, ['deploy-runtime', '--runtime', target.runtime]);
    const log = readFileSync(current.log, 'utf8');
    expect(log).toContain('delete metabot\n');
    expect(log).toContain('delete metabot-worker-runnerd\n');
    expect(log).toContain('delete metabot-arcd\n');
    expect(log).toContain(`start ${target.runtime}/ecosystem.config.cjs --update-env`);
    expect(log).toContain('save --force');
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
