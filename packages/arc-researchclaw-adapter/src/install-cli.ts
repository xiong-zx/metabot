#!/usr/bin/env node
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { probeOfficialResearchClaw } from './adapter.js';
import {
  OFFICIAL_RESEARCHCLAW_REPOSITORY,
  OFFICIAL_RESEARCHCLAW_REVISION,
  OFFICIAL_RESEARCHCLAW_STAGE_COUNT,
  OFFICIAL_RESEARCHCLAW_VERSION,
  ACPX_VERSION,
} from './release.js';

const args = process.argv.slice(2);
const command = args.shift() ?? 'doctor';
const home = path.resolve(option(args, '--home') ?? process.env.METABOT_ARC_OFFICIAL_HOME ?? path.join(os.homedir(), '.metabot', 'arc-official'));
const source = path.join(home, 'source');
const venv = path.join(home, 'venv');
const python = path.join(venv, 'bin', 'python3');
const bridge = fileURLToPath(new URL('../python/bridge.py', import.meta.url));
const officialCompat = fileURLToPath(new URL('../python/official_compat.py', import.meta.url));

if (command === 'install') {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const bootstrapPython = option(args, '--python') ?? process.env.PYTHON ?? 'python3.11';
  assertPython(bootstrapPython);
  if (!existsSync(source)) {
    run('git', ['clone', '--filter=blob:none', OFFICIAL_RESEARCHCLAW_REPOSITORY, source]);
  } else {
    assertSafeDirectory(source);
    const remote = output('git', ['-C', source, 'remote', 'get-url', 'origin']).trim();
    if (remote !== OFFICIAL_RESEARCHCLAW_REPOSITORY && remote !== OFFICIAL_RESEARCHCLAW_REPOSITORY.replace(/\.git$/, '')) {
      throw new Error(`Existing official ARC source has an unexpected origin: ${remote}`);
    }
    const dirty = output('git', ['-C', source, 'status', '--porcelain']);
    if (dirty.trim()) throw new Error('Existing official ARC source is dirty; refusing to overwrite it');
  }
  run('git', ['-C', source, 'fetch', '--depth=1', 'origin', OFFICIAL_RESEARCHCLAW_REVISION]);
  run('git', ['-C', source, 'checkout', '--detach', OFFICIAL_RESEARCHCLAW_REVISION]);
  const actual = output('git', ['-C', source, 'rev-parse', 'HEAD']).trim();
  if (actual !== OFFICIAL_RESEARCHCLAW_REVISION) throw new Error(`Official ARC revision mismatch: ${actual}`);
  if (!existsSync(python)) run(bootstrapPython, ['-m', 'venv', venv]);
  run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '-e', `${source}[all]`]);
  if (!findCommand('acpx')) run('npm', ['install', '--global', `acpx@${ACPX_VERSION}`]);
  await doctor();
  printEnvironment();
} else if (command === 'doctor') {
  await doctor();
  printEnvironment();
} else {
  throw new Error('Usage: metabot-arc-official install [--home PATH] [--python PYTHON] | doctor [--home PATH]');
}

async function doctor(): Promise<void> {
  if (!existsSync(python)) throw new Error(`Official ARC virtualenv is missing: ${python}`);
  const probe = await probeOfficialResearchClaw(python, bridge);
  const revision = output('git', ['-C', source, 'rev-parse', 'HEAD']).trim();
  if (revision !== OFFICIAL_RESEARCHCLAW_REVISION) throw new Error(`Official ARC source revision mismatch: ${revision}`);
  if (probe.stage_count !== OFFICIAL_RESEARCHCLAW_STAGE_COUNT || probe.version !== OFFICIAL_RESEARCHCLAW_VERSION) {
    throw new Error(`Official ARC compatibility check failed: ${JSON.stringify(probe)}`);
  }
  const compatibility = JSON.parse(output(python, [officialCompat])) as { success?: boolean };
  if (compatibility.success !== true) {
    throw new Error(`Official ARC downstream compatibility check failed: ${JSON.stringify(compatibility)}`);
  }
  const acpx = findCommand('acpx');
  const codex = findCommand(process.env.METABOT_ARC_ACP_AGENT?.trim() || 'codex');
  if (!acpx) throw new Error('acpx is missing; install it with npm install --global acpx');
  const acpxVersion = output(acpx, ['--version']).trim();
  if (acpxVersion !== ACPX_VERSION) {
    throw new Error(`acpx version mismatch: expected ${ACPX_VERSION}, got ${acpxVersion}`);
  }
  if (!codex) throw new Error('The configured ACP agent is missing from PATH');
  process.stdout.write(
    `Official AutoResearchClaw ${probe.version} ready (${probe.stage_count} stages, ${revision.slice(0, 12)}).\n` +
      `Python: ${realpathSync.native(python)}\nACP bridge: ${acpx} (${acpxVersion})\nACP agent: ${codex}\n`,
  );
}

function printEnvironment(): void {
  process.stdout.write(`METABOT_ARC_RESEARCHCLAW_PYTHON=${python}\n`);
}

function assertPython(binary: string): void {
  const version = output(binary, ['-c', 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")']).trim();
  const [major, minor] = version.split('.').map(Number);
  if ((major ?? 0) < 3 || ((major ?? 0) === 3 && (minor ?? 0) < 11)) {
    throw new Error(`Python 3.11 or newer is required, got ${version}`);
  }
}

function assertSafeDirectory(directory: string): void {
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe install directory: ${directory}`);
}

function option(values: string[], name: string): string | undefined {
  const index = values.indexOf(name);
  if (index < 0) return undefined;
  const value = values[index + 1];
  if (!value) throw new Error(`${name} requires a value`);
  values.splice(index, 2);
  return value;
}

function findCommand(command: string): string | undefined {
  const result = spawnSync('sh', ['-c', 'command -v "$1"', 'sh', command], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function output(commandName: string, commandArgs: string[]): string {
  const result = spawnSync(commandName, commandArgs, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${commandName} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

function run(commandName: string, commandArgs: string[]): void {
  const result = spawnSync(commandName, commandArgs, { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${commandName} exited with ${result.status ?? 'no status'}`);
}
