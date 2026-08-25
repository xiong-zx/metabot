import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REAL_PS = execFileSync('sh', ['-c', 'command -v ps'], { encoding: 'utf8' }).trim();

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
    'packages/rulespack/dist',
    'packages/rulespack-adapter/dist',
    'packages/worker-runner-mcp/dist',
    'packages/arc-mcp/dist',
    'packages/server/dist',
    'node_modules',
  ]) mkdirSync(join(runtime, path), { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  cpSync(join(REPO_ROOT, 'bin/metabot'), join(runtime, 'bin/metabot'));
  chmodSync(join(runtime, 'bin/metabot'), 0o755);
  for (const path of [
    'src/index.ts',
    'src/runtime/restart-state-cli.ts',
    'scripts/pm2-protected-runtime-switch.cjs',
    'packages/rulespack/dist/index.js',
    'packages/rulespack-adapter/dist/index.js',
    'packages/server/dist/index.js',
    'src/services/local-daemon-health.ts',
    'packages/worker-runner-mcp/dist/daemon-cli.js',
    'ecosystem.config.cjs',
    'ecosystem.core.config.cjs',
  ]) writeFileSync(join(runtime, path), '// fixture\n');
  symlinkSync(join(REPO_ROOT, 'node_modules/tsx'), join(runtime, 'node_modules/tsx'));
  symlinkSync(join(REPO_ROOT, 'node_modules/better-sqlite3'), join(runtime, 'node_modules/better-sqlite3'));
  const switchHelper = join(root, 'protected-switch.cjs');
  writeFileSync(switchHelper, [
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    "const value = (name) => args[args.indexOf(name) + 1];",
    "const planOnly = value('--plan-only') === 'true';",
    "const context = `request=${process.env.METABOT_RESTART_REQUEST_ID || ''} source=${process.env.METABOT_RESTART_SOURCE || ''} bot=${process.env.METABOT_BOT_NAME || ''} chat=${process.env.METABOT_CHAT_ID || ''}`;",
    "fs.appendFileSync(process.env.PM2_LOG, `${planOnly ? 'protected-plan' : 'protected-switch'} ${args.join(' ')} ${context}\\n`);",
    "if (planOnly) {",
    "  const root = value('--runtime');",
    "  const scripts = { metabot: 'src/index.ts', 'metabot-worker-runnerd': 'packages/worker-runner-mcp/dist/daemon-cli.js', 'metabot-core': 'packages/server/dist/index.js' };",
    "  const plan = Object.fromEntries(value('--apps').split(',').map((app) => [app, { cwd: root, script: require('node:path').join(root, scripts[app]), interpreter: 'node', interpreterArgs: [], envHashes: {} }]));",
    "  process.stdout.write(JSON.stringify(plan) + '\\n');",
    "} else if (process.env.FAKE_SWITCH_FAIL === 'true') process.exit(1);",
    "else process.stdout.write(JSON.stringify({ ok: true }) + '\\n');",
  ].join('\n'));
  writeExecutable(join(fakeBin, 'pm2'), [
    '#!/usr/bin/env bash',
    'printf "%s\\n" "$*" >> "$PM2_LOG"',
    'if [[ "${1:-}" == "jlist" ]]; then',
    '  if [[ "${FAKE_PM2_JLIST_FAIL:-}" == "true" ]]; then exit 1; fi',
    '  core=""',
    '  if [[ -n "${FAKE_CORE_RUNTIME:-}" ]]; then core=",{\\"name\\":\\"metabot-core\\",\\"pid\\":104,\\"pm2_env\\":{\\"status\\":\\"online\\",\\"pm_cwd\\":\\"$FAKE_CORE_RUNTIME\\",\\"pm_exec_path\\":\\"$FAKE_CORE_RUNTIME/packages/server/dist/index.js\\"}}"; fi',
    '  printf \'[{"name":"metabot","pid":101,"pm2_env":{"status":"online","pm_cwd":"%s","pm_exec_path":"%s/src/index.ts"}},{"name":"metabot-worker-runnerd","pid":102,"pm2_env":{"status":"online","pm_cwd":"%s","pm_exec_path":"%s/packages/worker-runner-mcp/dist/daemon-cli.js"}}%s]\\n\' "$FAKE_RUNTIME" "$FAKE_RUNTIME" "$FAKE_RUNTIME" "$FAKE_RUNTIME" "$core"',
    'fi',
  ]);
  writeExecutable(join(fakeBin, 'node'), [
    '#!/usr/bin/env bash',
    'if [[ "$*" == *"--busy ${FAKE_BUSY_DAEMON:-__none__}"* ]]; then exit 10; fi',
    'if [[ "$*" == *"local-daemon-health.ts"* ]]; then exit 0; fi',
    'exec "$REAL_NODE" "$@"',
  ]);
  writeExecutable(join(fakeBin, 'ps'), [
    '#!/usr/bin/env bash',
    'if [[ "${FAKE_PS_FAIL:-}" == "true" ]]; then exit 1; fi',
    'exec "$REAL_PS" "$@"',
  ]);
  writeExecutable(join(fakeBin, 'curl'), [
    '#!/usr/bin/env bash',
    'printf "curl %s\\n" "$*" >> "$PM2_LOG"',
    'out=""',
    'want_code=false',
    'args=("$@")',
    'for ((i=0; i<${#args[@]}; i++)); do',
    '  [[ "${args[$i]}" == "-o" ]] && out="${args[$((i+1))]}"',
    '  [[ "${args[$i]}" == "-w" ]] && want_code=true',
    'done',
    'if [[ "$*" == *"/api/runtime/restart/prepare"* ]]; then',
    '  status="${FAKE_PREPARE_STATUS:-200}"',
    '  [[ -n "$out" ]] && printf \'{"status":"prepared"}\' > "$out"',
    '  [[ "$want_code" == true ]] && printf "%s" "$status"',
    '  exit 0',
    'fi',
    'if [[ "$*" == *"/api/runtime/restart/cancel"* ]]; then',
    '  [[ -n "$out" ]] && printf \'{"status":"cancelled"}\' > "$out"',
    '  [[ "$want_code" == true ]] && printf "200"',
    'fi',
    'exit 0',
  ]);
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
      REAL_PS,
      HOME: join(root, 'home'),
      API_SECRET: '',
      METABOT_RESTART_REQUEST_ID: '',
      METABOT_BOT_NAME: '',
      METABOT_CHAT_ID: '',
      METABOT_CHAT: '',
      METABOT_TEAM_CAPABILITY: '',
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
    expect(log).toContain('/api/runtime/restart/prepare');
    expect(log).toContain(`protected-switch --runtime ${kit.runtime} --apps metabot`);
    expect(log.indexOf('/api/runtime/restart/prepare')).toBeLessThan(log.indexOf('protected-switch --runtime'));
    expect(log).not.toContain('restart metabot-worker-runnerd');
    expect(log).not.toContain('delete ');
    expect(log).not.toContain('save --force');
  });

  it('forwards the scoped capability for restart without exposing the Bridge admin secret', () => {
    const kit = fixture();
    run(kit, ['restart', '--bot', 'admin', '--chat', 'oc_capability'], {
      API_SECRET: 'bridge-admin-secret-must-not-leak',
      METABOT_TEAM_CAPABILITY: 'signed-restart-capability',
      METABOT_BOT_NAME: 'admin',
      METABOT_CHAT_ID: 'oc_capability',
    });
    const log = readFileSync(kit.log, 'utf8');
    expect(log).toContain('X-MetaBot-Team-Capability: signed-restart-capability');
    expect(log).toContain('X-MetaBot-Bot-Name: admin');
    expect(log).toContain('X-MetaBot-Chat-Id: oc_capability');
    expect(log).not.toContain('bridge-admin-secret-must-not-leak');
  });

  it('refuses the protected switch when multi-bot prepare is rejected', () => {
    const kit = fixture();
    expect(() => run(kit, ['restart'], { FAKE_PREPARE_STATUS: '409' })).toThrow(
      /could not checkpoint and notify all affected chats/,
    );
    const log = readFileSync(kit.log, 'utf8');
    expect(log).toContain('/api/runtime/restart/prepare');
    expect(log).not.toContain('protected-switch --runtime');
  });

  it('cancels Bridge quiesce when the protected PM2 switch fails', () => {
    const kit = fixture();
    expect(() => run(kit, ['restart'], { FAKE_SWITCH_FAIL: 'true' })).toThrow();
    const log = readFileSync(kit.log, 'utf8');
    expect(log).toContain('/api/runtime/restart/prepare');
    expect(log).toContain('/api/runtime/restart/cancel');
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

  it('uses the same restart context while planning and switching runtime expectations', () => {
    const kit = fixture();
    run(kit, [
      'restart', '--request-id', 'restart-context-1', '--source', 'pm',
      '--bot', 'admin', '--chat', 'oc_context', '--reason', 'context check',
    ]);
    const lifecycle = readFileSync(kit.log, 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('protected-plan ') || line.startsWith('protected-switch '));
    expect(lifecycle).toHaveLength(2);
    for (const line of lifecycle) {
      expect(line).toContain('request=restart-context-1');
      expect(line).toContain('source=pm');
      expect(line).toContain('bot=admin');
      expect(line).toContain('chat=oc_context');
    }
  });

  it('refuses a wrong live runtime or missing artifact before the protected switch', () => {
    const wrongRuntime = fixture();
    expect(() => run(wrongRuntime, ['restart'], { FAKE_RUNTIME: '/srv/other-metabot' })).toThrow(
      /Same-runtime restart refused/,
    );
    expect(readFileSync(wrongRuntime.log, 'utf8')).not.toContain('protected-switch');

    const missingArtifact = fixture();
    rmSync(join(missingArtifact.runtime, 'src', 'index.ts'));
    expect(() => run(missingArtifact, ['restart'])).toThrow(/Missing built runtime artifact/);
    expect(() => readFileSync(missingArtifact.log, 'utf8')).toThrow();
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
  });

  it('deploy-runtime switches all sibling apps without delete/start/save in the old process', () => {
    const current = fixture();
    const target = fixture();
    run(current, ['deploy-runtime', '--runtime', target.runtime, '--no-wait']);
    const log = readFileSync(current.log, 'utf8');
    expect(log).toContain(`protected-switch --runtime ${realpathSync(target.runtime)} --apps metabot-worker-runnerd,metabot`);
    expect(log).not.toContain('delete ');
    expect(log).not.toContain('start ');
    expect(log).not.toContain('save --force');
  });

  it('uses the same deployment context while planning and switching a new runtime', () => {
    const current = fixture();
    const target = fixture();
    run(current, [
      'deploy-runtime', '--runtime', target.runtime, '--request-id', 'deploy-context-1',
      '--source', 'admin', '--bot', 'admin', '--chat', 'oc_deploy', '--reason', 'deploy context', '--no-wait',
    ]);
    const lifecycle = readFileSync(current.log, 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('protected-plan ') || line.startsWith('protected-switch '));
    expect(lifecycle).toHaveLength(2);
    for (const line of lifecycle) {
      expect(line).toContain('request=deploy-context-1');
      expect(line).toContain('source=admin');
      expect(line).toContain('bot=admin');
      expect(line).toContain('chat=oc_deploy');
    }
  });

  it('fails closed when the live PM2 process tree cannot be verified', () => {
    const missingLivePid = fixture();
    const targetForMissingPid = fixture();
    expect(() => run(
      missingLivePid,
      ['deploy-runtime', '--runtime', targetForMissingPid.runtime, '--no-wait'],
      { FAKE_PM2_JLIST_FAIL: 'true' },
    )).toThrow(/process tree could not be verified/);
    expect(readFileSync(missingLivePid.log, 'utf8')).not.toContain('protected-switch ');

    const unreadableAncestry = fixture();
    const targetForUnreadableAncestry = fixture();
    expect(() => run(
      unreadableAncestry,
      ['deploy-runtime', '--runtime', targetForUnreadableAncestry.runtime, '--no-wait'],
      { FAKE_PS_FAIL: 'true' },
    )).toThrow(/process tree could not be verified/);
    expect(readFileSync(unreadableAncestry.log, 'utf8')).not.toContain('protected-switch ');
  });

  it('includes only a checkout-owned Core in a protected runtime cutover', () => {
    const owned = fixture();
    const ownedTarget = fixture();
    run(owned, ['deploy-runtime', '--runtime', ownedTarget.runtime, '--no-wait'], {
      FAKE_CORE_RUNTIME: owned.runtime,
    });
    expect(readFileSync(owned.log, 'utf8')).toContain(
      `--apps metabot-worker-runnerd,metabot-core,metabot`,
    );

    const external = fixture();
    const externalTarget = fixture();
    run(external, ['deploy-runtime', '--runtime', externalTarget.runtime, '--no-wait'], {
      FAKE_CORE_RUNTIME: '/srv/external-core',
    });
    expect(readFileSync(external.log, 'utf8')).toContain(
      `--apps metabot-worker-runnerd,metabot`,
    );
    expect(readFileSync(external.log, 'utf8')).not.toContain(',metabot-core,');
  }, 15_000);

  it('uses wire-only health code and builds every daemon workspace on update', () => {
    const health = readFileSync(join(REPO_ROOT, 'src/services/local-daemon-health.ts'), 'utf8');
    const cli = readFileSync(join(REPO_ROOT, 'bin/metabot'), 'utf8');
    const uninstall = readFileSync(join(REPO_ROOT, 'uninstall.sh'), 'utf8');
    const production = readFileSync(join(REPO_ROOT, 'docs/deployment/production.md'), 'utf8');
    expect(health).toContain('StreamableHTTPClientTransport');
    expect(health).toContain("name: 'worker_list'");
    expect(health).not.toContain("name: 'arc_run_list'");
    expect(health).not.toMatch(/@xvirobotics\/(?:worker-runner-mcp|arc-mcp|arc-worker-runner-adapter|arc-researchclaw-adapter)/);
    for (const workspace of ['worker-runner-mcp']) {
      expect(cli).toContain(`npm run build -w @xvirobotics/${workspace}`);
    }
    expect(uninstall).toContain('for app in metabot metabot-worker-runnerd');
    expect(uninstall).toContain('pm2_app_owned_by_runtime metabot-core');
    expect(uninstall).toContain('Leaving metabot-core untouched');
    expect(production).toContain('pm2 delete metabot-worker-runnerd');
  });
});
