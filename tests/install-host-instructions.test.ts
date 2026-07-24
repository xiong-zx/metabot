import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SH_SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'install.sh'), 'utf-8');
const PS_SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'install.ps1'), 'utf-8');

/** Same extraction helper style as tests/install-runtime-prereqs.test.ts. */
function extractBashFunction(name: string): string {
  const startMarker = `${name}() {`;
  const start = SH_SOURCE.indexOf(startMarker);
  if (start === -1) throw new Error(`Missing ${name} in install.sh`);
  const end = SH_SOURCE.indexOf('\n}\n', start);
  if (end === -1) throw new Error(`Missing end of ${name} in install.sh`);
  return SH_SOURCE.slice(start, end + 3);
}

const LOG_STUBS = `
info() { echo "INFO: $*"; }
warn() { echo "WARN: $*"; }
error() { echo "ERROR: $*"; }
success() { echo "OK: $*"; }
step() { :; }
`;

let tmp: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-instructions-')));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function runBash(script: string): string {
  return execFileSync('bash', ['-c', script], { encoding: 'utf-8' });
}

describe('installer guarantees $METABOT_HOME host instruction files', () => {
  function homeInstructionsScript(extra = ''): string {
    const fn = extractBashFunction('ensure_home_instructions');
    return `${LOG_STUBS}
METABOT_HOME="${tmp}"
${fn}
${extra}
ensure_home_instructions
`;
  }

  it('links AGENTS.md to CLAUDE.md when only AGENTS.md is missing', () => {
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), '# rules\n');

    const out = runBash(homeInstructionsScript());

    const agents = path.join(tmp, 'AGENTS.md');
    expect(fs.lstatSync(agents).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(agents, 'utf-8')).toBe('# rules\n');
    expect(out).toContain('Host instructions present');
  });

  it('leaves an existing CLAUDE.md / AGENTS.md pair untouched', () => {
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), '# rules\n');
    fs.writeFileSync(path.join(tmp, 'AGENTS.md'), '# separate agents file\n');

    runBash(homeInstructionsScript());

    expect(fs.readFileSync(path.join(tmp, 'AGENTS.md'), 'utf-8')).toBe('# separate agents file\n');
  });

  it('seeds a missing CLAUDE.md from the bundled workspace template', () => {
    fs.mkdirSync(path.join(tmp, 'src', 'workspace'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'src', 'workspace', 'CLAUDE.md'), '# workspace template\n');

    const out = runBash(homeInstructionsScript());

    expect(fs.readFileSync(path.join(tmp, 'CLAUDE.md'), 'utf-8')).toBe('# workspace template\n');
    expect(fs.existsSync(path.join(tmp, 'AGENTS.md'))).toBe(true);
    expect(out).toContain('seeded it from src/workspace/CLAUDE.md');
  });

  it('fails loudly when neither CLAUDE.md nor the template exists', () => {
    const out = runBash(`${homeInstructionsScript()}\nensure_home_instructions || echo "RC=nonzero"\n`);

    expect(out).toContain('checkout is incomplete');
    expect(out).toContain('RC=nonzero');
    expect(fs.existsSync(path.join(tmp, 'CLAUDE.md'))).toBe(false);
  });

  it('is idempotent across repeated installs', () => {
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), '# rules\n');

    runBash(homeInstructionsScript());
    runBash(homeInstructionsScript());
    runBash(homeInstructionsScript());

    expect(fs.readdirSync(tmp).sort()).toEqual(['AGENTS.md', 'CLAUDE.md']);
    expect(fs.lstatSync(path.join(tmp, 'AGENTS.md')).isSymbolicLink()).toBe(true);
  });

  it('falls back to a copy when symlinks are unavailable', () => {
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), '# rules\n');
    // Shadow `ln` with a failing stub to simulate a filesystem that rejects
    // symlinks; the installer must still leave an AGENTS.md behind.
    const binDir = path.join(tmp, 'stub-bin');
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, 'ln'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });

    const out = runBash(homeInstructionsScript(`export PATH="${binDir}:$PATH"`));

    const agents = path.join(tmp, 'AGENTS.md');
    expect(fs.lstatSync(agents).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(agents, 'utf-8')).toBe('# rules\n');
    expect(out).toContain('Symlinks unavailable');
  });

  it('runs the assertion outside the workspace-deployment branch', () => {
    // The DEPLOY_WORK_DIR block is skipped when no working directory can be
    // determined; the METABOT_HOME guarantee must not be skipped with it.
    const call = SH_SOURCE.indexOf('ensure_home_instructions || warn');
    const branchEnd = SH_SOURCE.indexOf('warn "Could not determine working directory');
    expect(call).toBeGreaterThan(branchEnd);
  });

  it('asserts the same guarantee in install.ps1', () => {
    expect(PS_SOURCE).toContain('$HomeClaude = Join-Path $MetabotHome "CLAUDE.md"');
    expect(PS_SOURCE).toContain('$HomeAgents = Join-Path $MetabotHome "AGENTS.md"');
    expect(PS_SOURCE).toContain('Derived AGENTS.md from CLAUDE.md');
    expect(PS_SOURCE).toContain('Host instructions present');
  });
});
