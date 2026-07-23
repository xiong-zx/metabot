import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..');
const metabotBin = path.join(repoRoot, 'bin', 'metabot');
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-cli-resolution-'));
  tempRoots.push(root);
  return root;
}

function writeFeatureCli(root: string, built: boolean): string {
  const binDir = path.join(root, 'packages', 'cli', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const entry = path.join(binDir, 'metabot');
  fs.writeFileSync(entry, "#!/usr/bin/env node\nrequire('../dist/index.js').main(process.argv.slice(2));\n");
  if (built) {
    const distDir = path.join(root, 'packages', 'cli', 'dist');
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(
      path.join(distDir, 'index.js'),
      'exports.main = (argv) => console.log(JSON.stringify({ argv, coreUrl: process.env.METABOT_CORE_URL }));\n',
    );
  }
  return entry;
}

function baseEnv(home: string, metabotHome: string, defaultEnvFile: string): NodeJS.ProcessEnv {
  const env = {
    ...process.env,
    HOME: home,
    METABOT_HOME: metabotHome,
    METABOT_DEFAULT_ENV_FILE: defaultEnvFile,
  };
  delete env.METABOT_CORE_CLI;
  delete env.METABOT_CORE_URL;
  delete env.METABOT_CORE_TOKEN;
  return env;
}

describe('metabot feature CLI resolution', () => {
  it('falls back from an unbuilt worktree to the ready default-config checkout', () => {
    const root = makeTempRoot();
    const home = path.join(root, 'home');
    const unbuilt = path.join(root, 'worktree');
    const stable = path.join(root, 'stable');
    fs.mkdirSync(home, { recursive: true });
    writeFeatureCli(unbuilt, false);
    writeFeatureCli(stable, true);
    const defaultEnvFile = path.join(stable, '.env');
    fs.writeFileSync(defaultEnvFile, 'METABOT_CORE_URL=http://memory-core.example.test\n');

    const result = spawnSync('bash', [metabotBin, 'memory', 'search', 'needle'], {
      encoding: 'utf8',
      env: baseEnv(home, unbuilt, defaultEnvFile),
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      argv: ['memory', 'search', 'needle'],
      coreUrl: 'http://memory-core.example.test',
    });
  });

  it('uses a symlinked default env file target to locate the ready checkout', () => {
    const root = makeTempRoot();
    const home = path.join(root, 'home');
    const unbuilt = path.join(root, 'worktree');
    const stable = path.join(root, 'ready checkout');
    const linkDir = path.join(root, 'linked config');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(linkDir, { recursive: true });
    writeFeatureCli(unbuilt, false);
    writeFeatureCli(stable, true);
    const realDefaultEnvFile = path.join(stable, '.env');
    const linkedDefaultEnvFile = path.join(linkDir, 'metabot.env');
    fs.writeFileSync(realDefaultEnvFile, 'METABOT_CORE_URL=http://symlink-config.example.test\n');
    fs.symlinkSync(realDefaultEnvFile, linkedDefaultEnvFile);

    const result = spawnSync('bash', [metabotBin, 'memory', 'search', 'needle'], {
      encoding: 'utf8',
      env: baseEnv(home, unbuilt, linkedDefaultEnvFile),
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      argv: ['memory', 'search', 'needle'],
      coreUrl: 'http://symlink-config.example.test',
    });
  });

  it('keeps backend config selection separate from code-path selection, including spaced paths', () => {
    const root = makeTempRoot();
    const home = path.join(root, 'home dir');
    const unbuilt = path.join(root, 'worktree with spaces');
    const stable = path.join(root, 'ready checkout');
    fs.mkdirSync(home, { recursive: true });
    writeFeatureCli(unbuilt, false);
    writeFeatureCli(stable, true);
    const defaultEnvFile = path.join(stable, '.env');
    fs.writeFileSync(defaultEnvFile, 'METABOT_CORE_URL=http://stable-config.example.test\n');
    fs.writeFileSync(path.join(unbuilt, '.env'), 'METABOT_CORE_URL=http://worktree-config.example.test\n');

    const result = spawnSync('bash', [metabotBin, 'memory', 'search', 'needle'], {
      encoding: 'utf8',
      env: baseEnv(home, unbuilt, defaultEnvFile),
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      argv: ['memory', 'search', 'needle'],
      coreUrl: 'http://worktree-config.example.test',
    });
  });

  it('fails closed when an explicit CLI override is missing its dist artifact', () => {
    const root = makeTempRoot();
    const home = path.join(root, 'home');
    const unbuilt = path.join(root, 'worktree');
    const stable = path.join(root, 'stable');
    fs.mkdirSync(home, { recursive: true });
    const brokenOverride = writeFeatureCli(unbuilt, false);
    writeFeatureCli(stable, true);
    const defaultEnvFile = path.join(stable, '.env');
    fs.writeFileSync(defaultEnvFile, 'METABOT_CORE_URL=http://memory-core.example.test\n');
    const env = baseEnv(home, unbuilt, defaultEnvFile);
    env.METABOT_CORE_CLI = brokenOverride;

    const result = spawnSync('bash', [metabotBin, 'memory', 'health'], {
      encoding: 'utf8',
      env,
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Explicit METABOT_CORE_CLI is not runnable');
    expect(result.stderr).toContain('npm run build -w @xvirobotics/cli');
  });

  it('expands a ready explicit CLI override under home before runtime delegation', () => {
    const root = makeTempRoot();
    const home = path.join(root, 'home');
    const unbuilt = path.join(root, 'worktree');
    const ready = path.join(home, 'ready checkout');
    fs.mkdirSync(home, { recursive: true });
    writeFeatureCli(unbuilt, false);
    writeFeatureCli(ready, true);
    const defaultEnvFile = path.join(unbuilt, '.env');
    fs.writeFileSync(defaultEnvFile, 'METABOT_CORE_URL=http://tilde-override.example.test\n');
    const env = baseEnv(home, unbuilt, defaultEnvFile);
    env.METABOT_CORE_CLI = '~/ready checkout/packages/cli/bin/metabot';

    const result = spawnSync('bash', [metabotBin, 'memory', 'search', 'needle'], {
      encoding: 'utf8',
      env,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      argv: ['memory', 'search', 'needle'],
      coreUrl: 'http://tilde-override.example.test',
    });
  });

  it('rejects a PATH metabot-core symlink to an unbuilt source-tree launcher at runtime', () => {
    const root = makeTempRoot();
    const home = path.join(root, 'home');
    const unbuilt = path.join(root, 'worktree');
    const configOnly = path.join(root, 'config-only');
    const pathBin = path.join(root, 'path-bin');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(configOnly, { recursive: true });
    fs.mkdirSync(pathBin, { recursive: true });
    const unbuiltEntry = writeFeatureCli(unbuilt, false);
    fs.chmodSync(unbuiltEntry, 0o755);
    const defaultEnvFile = path.join(configOnly, '.env');
    fs.writeFileSync(defaultEnvFile, 'METABOT_CORE_URL=http://127.0.0.1:1\n');
    fs.symlinkSync(unbuiltEntry, path.join(pathBin, 'metabot-core'));
    const env = baseEnv(home, unbuilt, defaultEnvFile);
    env.PATH = `${pathBin}:${process.env.PATH ?? ''}`;

    const result = spawnSync('bash', [metabotBin, 'memory', 'health'], {
      encoding: 'utf8',
      env,
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('needs the metabot-core CLI');
    expect(result.stderr).not.toContain('Cannot find module');
  });

  it('keeps resolving stable fallbacks when METABOT_DEFAULT_ENV_FILE is unset under bash set -e', () => {
    const root = makeTempRoot();
    const home = path.join(root, 'home');
    const unbuilt = path.join(root, 'worktree');
    const stable = path.join(home, 'metabot');
    fs.mkdirSync(home, { recursive: true });
    writeFeatureCli(unbuilt, false);
    writeFeatureCli(stable, true);
    const env = baseEnv(home, unbuilt, path.join(root, 'unused.env'));
    delete env.METABOT_DEFAULT_ENV_FILE;
    env.METABOT_CORE_URL = 'http://unset-default-env.example.test';

    const result = spawnSync('bash', [metabotBin, 'memory', 'search', 'needle'], {
      encoding: 'utf8',
      env,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      argv: ['memory', 'search', 'needle'],
      coreUrl: 'http://unset-default-env.example.test',
    });
  });

  it('reports CLI artifact and shared config roots in doctor preflight', () => {
    const root = makeTempRoot();
    const home = path.join(root, 'home');
    const unbuilt = path.join(root, 'worktree');
    const stable = path.join(root, 'stable');
    fs.mkdirSync(home, { recursive: true });
    writeFeatureCli(unbuilt, false);
    const stableEntry = writeFeatureCli(stable, true);
    const defaultEnvFile = path.join(stable, '.env');
    fs.writeFileSync(defaultEnvFile, 'METABOT_CORE_URL=http://127.0.0.1:1\nMETABOT_URL=http://127.0.0.1:1\n');
    const env = baseEnv(home, unbuilt, defaultEnvFile);
    env.METABOT_URL = 'http://127.0.0.1:1';
    env.METABOT_CORE_URL = 'http://127.0.0.1:1';

    const result = spawnSync('bash', [metabotBin, 'doctor', '--json'], {
      encoding: 'utf8',
      env,
      timeout: 15_000,
    });

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as {
      configFiles: { defaultEnv: string; worktreeEnv: string };
      checks: Array<{ name: string; ok: boolean; data?: Record<string, unknown> }>;
    };
    expect(report.configFiles).toMatchObject({
      defaultEnv: defaultEnvFile,
      defaultEnvResolved: defaultEnvFile,
      worktreeEnv: path.join(unbuilt, '.env'),
    });
    const cliCheck = report.checks.find((check) => check.name === 'core_cli_artifact');
    expect(cliCheck).toMatchObject({
      ok: true,
      data: {
        configRoot: stable,
        selected: {
          source: 'default_config_root',
          entry: stableEntry,
          ready: true,
        },
      },
    });
  });

  it('reports both configured and resolved default env paths in doctor preflight', () => {
    const root = makeTempRoot();
    const home = path.join(root, 'home');
    const unbuilt = path.join(root, 'worktree');
    const stable = path.join(root, 'ready checkout');
    const linkDir = path.join(root, 'linked config');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(linkDir, { recursive: true });
    writeFeatureCli(unbuilt, false);
    const stableEntry = writeFeatureCli(stable, true);
    const realDefaultEnvFile = path.join(stable, '.env');
    const linkedDefaultEnvFile = path.join(linkDir, 'metabot.env');
    fs.writeFileSync(realDefaultEnvFile, 'METABOT_CORE_URL=http://127.0.0.1:1\nMETABOT_URL=http://127.0.0.1:1\n');
    fs.symlinkSync(realDefaultEnvFile, linkedDefaultEnvFile);
    const env = baseEnv(home, unbuilt, linkedDefaultEnvFile);
    env.METABOT_URL = 'http://127.0.0.1:1';
    env.METABOT_CORE_URL = 'http://127.0.0.1:1';

    const result = spawnSync('bash', [metabotBin, 'doctor', '--json'], {
      encoding: 'utf8',
      env,
      timeout: 15_000,
    });

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as {
      configFiles: { defaultEnv: string; defaultEnvResolved: string; worktreeEnv: string };
      checks: Array<{ name: string; ok: boolean; data?: Record<string, unknown> }>;
    };
    expect(report.configFiles).toMatchObject({
      defaultEnv: linkedDefaultEnvFile,
      defaultEnvResolved: realDefaultEnvFile,
      worktreeEnv: path.join(unbuilt, '.env'),
    });
    const cliCheck = report.checks.find((check) => check.name === 'core_cli_artifact');
    expect(cliCheck).toMatchObject({
      ok: true,
      data: {
        configuredDefaultEnv: linkedDefaultEnvFile,
        resolvedDefaultEnv: realDefaultEnvFile,
        configRoot: stable,
        selected: expect.objectContaining({
          source: 'default_config_root',
          entry: stableEntry,
          ready: true,
        }),
      },
    });
  });

  it('deduplicates doctor CLI candidates when default-config and stable roots coincide', () => {
    const root = makeTempRoot();
    const home = path.join(root, 'home');
    const unbuilt = path.join(root, 'worktree');
    const stable = path.join(home, 'metabot');
    fs.mkdirSync(home, { recursive: true });
    writeFeatureCli(unbuilt, false);
    const stableEntry = writeFeatureCli(stable, true);
    const defaultEnvFile = path.join(stable, '.env');
    fs.writeFileSync(defaultEnvFile, 'METABOT_CORE_URL=http://127.0.0.1:1\nMETABOT_URL=http://127.0.0.1:1\n');
    const env = baseEnv(home, unbuilt, defaultEnvFile);
    env.METABOT_URL = 'http://127.0.0.1:1';
    env.METABOT_CORE_URL = 'http://127.0.0.1:1';

    const result = spawnSync('bash', [metabotBin, 'doctor', '--json'], {
      encoding: 'utf8',
      env,
      timeout: 15_000,
    });

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as {
      checks: Array<{ name: string; data?: { candidates?: Array<{ source: string; entry: string; ready: boolean }> } }>;
    };
    const cliCheck = report.checks.find((check) => check.name === 'core_cli_artifact');
    expect(cliCheck?.data?.candidates).toEqual([
      expect.objectContaining({
        source: 'worktree',
        entry: path.join(unbuilt, 'packages', 'cli', 'bin', 'metabot'),
        ready: false,
      }),
      expect.objectContaining({
        source: 'default_config_root',
        entry: stableEntry,
        ready: true,
      }),
      expect.objectContaining({
        source: 'sibling_workspace',
      }),
    ]);
  });

  it('reports an explicit broken CLI override as not ready in doctor preflight', () => {
    const root = makeTempRoot();
    const home = path.join(root, 'home');
    const unbuilt = path.join(root, 'worktree');
    const stable = path.join(root, 'stable');
    fs.mkdirSync(home, { recursive: true });
    const brokenOverride = writeFeatureCli(unbuilt, false);
    writeFeatureCli(stable, true);
    const defaultEnvFile = path.join(stable, '.env');
    fs.writeFileSync(defaultEnvFile, 'METABOT_CORE_URL=http://127.0.0.1:1\nMETABOT_URL=http://127.0.0.1:1\n');
    const env = baseEnv(home, unbuilt, defaultEnvFile);
    env.METABOT_CORE_CLI = brokenOverride;
    env.METABOT_URL = 'http://127.0.0.1:1';
    env.METABOT_CORE_URL = 'http://127.0.0.1:1';

    const result = spawnSync('bash', [metabotBin, 'doctor', '--json'], {
      encoding: 'utf8',
      env,
      timeout: 15_000,
    });

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as {
      checks: Array<{
        name: string;
        ok: boolean;
        code: string;
        recommendedAction: string;
        data?: Record<string, unknown>;
      }>;
    };
    const cliCheck = report.checks.find((check) => check.name === 'core_cli_artifact');
    expect(cliCheck).toMatchObject({
      ok: false,
      code: 'core_cli_unbuilt',
      recommendedAction: expect.stringContaining('npm run build -w @xvirobotics/cli'),
      data: {
        selected: null,
        explicitOverride: true,
        candidates: [
          {
            source: 'explicit',
            entry: brokenOverride,
            entryExists: true,
            artifactExists: false,
            ready: false,
          },
        ],
      },
    });
  });

  it('expands explicit ~/ CLI overrides in doctor preflight', () => {
    const root = makeTempRoot();
    const home = path.join(root, 'home');
    const unbuilt = path.join(root, 'worktree');
    const ready = path.join(home, 'ready checkout');
    fs.mkdirSync(home, { recursive: true });
    writeFeatureCli(unbuilt, false);
    const readyEntry = writeFeatureCli(ready, true);
    const defaultEnvFile = path.join(unbuilt, '.env');
    fs.writeFileSync(defaultEnvFile, 'METABOT_CORE_URL=http://127.0.0.1:1\nMETABOT_URL=http://127.0.0.1:1\n');
    const env = baseEnv(home, unbuilt, defaultEnvFile);
    env.METABOT_CORE_CLI = '~/ready checkout/packages/cli/bin/metabot';
    env.METABOT_URL = 'http://127.0.0.1:1';
    env.METABOT_CORE_URL = 'http://127.0.0.1:1';

    const result = spawnSync('bash', [metabotBin, 'doctor', '--json'], {
      encoding: 'utf8',
      env,
      timeout: 15_000,
    });

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as {
      checks: Array<{ name: string; ok: boolean; data?: Record<string, unknown> }>;
    };
    const cliCheck = report.checks.find((check) => check.name === 'core_cli_artifact');
    expect(cliCheck).toMatchObject({
      ok: true,
      data: {
        explicitOverride: true,
        selected: expect.objectContaining({
          source: 'explicit',
          entry: readyEntry,
          resolvedEntry: readyEntry,
          ready: true,
        }),
      },
    });
  });

  it('reports a PATH metabot-core symlink to an unbuilt source-tree launcher as not ready in doctor preflight', () => {
    const root = makeTempRoot();
    const home = path.join(root, 'home');
    const unbuilt = path.join(root, 'worktree');
    const configOnly = path.join(root, 'config-only');
    const pathBin = path.join(root, 'path-bin');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(configOnly, { recursive: true });
    fs.mkdirSync(pathBin, { recursive: true });
    const unbuiltEntry = writeFeatureCli(unbuilt, false);
    fs.chmodSync(unbuiltEntry, 0o755);
    const pathEntry = path.join(pathBin, 'metabot-core');
    fs.symlinkSync(unbuiltEntry, pathEntry);
    const defaultEnvFile = path.join(configOnly, '.env');
    fs.writeFileSync(defaultEnvFile, 'METABOT_CORE_URL=http://127.0.0.1:1\nMETABOT_URL=http://127.0.0.1:1\n');
    const env = baseEnv(home, configOnly, defaultEnvFile);
    env.PATH = `${pathBin}:${process.env.PATH ?? ''}`;
    env.METABOT_URL = 'http://127.0.0.1:1';
    env.METABOT_CORE_URL = 'http://127.0.0.1:1';

    const result = spawnSync('bash', [metabotBin, 'doctor', '--json'], {
      encoding: 'utf8',
      env,
      timeout: 15_000,
    });

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as {
      checks: Array<{
        name: string;
        ok: boolean;
        code: string;
        data?: { selected?: unknown; candidates?: Array<Record<string, unknown>> };
      }>;
    };
    const cliCheck = report.checks.find((check) => check.name === 'core_cli_artifact');
    const pathCandidate = cliCheck?.data?.candidates?.find((candidate) => candidate.source === 'path');
    expect(cliCheck).toMatchObject({
      ok: false,
      code: 'core_cli_unbuilt',
      data: {
        selected: null,
      },
    });
    expect(pathCandidate).toMatchObject({
      source: 'path',
      entry: pathEntry,
      resolvedEntry: unbuiltEntry,
      artifact: path.join(unbuilt, 'packages', 'cli', 'dist', 'index.js'),
      artifactExists: false,
      ready: false,
    });
  });
});
