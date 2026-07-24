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

/** Slice a top-level (non-function) region of install.sh by anchor lines. */
function extractBashRegion(startAnchor: string, endAnchor: string): string {
  const start = SH_SOURCE.indexOf(startAnchor);
  if (start === -1) throw new Error(`Missing region start "${startAnchor}" in install.sh`);
  const end = SH_SOURCE.indexOf(endAnchor, start);
  if (end === -1) throw new Error(`Missing region end "${endAnchor}" in install.sh`);
  return SH_SOURCE.slice(start, end + endAnchor.length);
}

const LOG_STUBS = `
info() { echo "INFO: $*"; }
warn() { echo "WARN: $*"; }
error() { echo "ERROR: $*"; }
success() { echo "OK: $*"; }
step() { :; }
`;

const RC_REGION_START = '# Persist METABOT_HOME to the shell rc files';
const RC_REGION_END = 'info "Persisted METABOT_HOME=$METABOT_HOME to shell rc files"';

let tmp: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-install-')));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function runBash(script: string): string {
  return execFileSync('bash', ['-c', script], { encoding: 'utf-8' });
}

describe('installer persists METABOT_HOME', () => {
  it('writes METABOT_HOME into the freshly generated .env on both platforms', () => {
    expect(SH_SOURCE).toContain('echo "METABOT_HOME=${METABOT_HOME}"');
    expect(PS_SOURCE).toContain('METABOT_HOME=$MetabotHome');
  });

  it('appends METABOT_HOME to a pre-existing .env only when absent', () => {
    const fn = extractBashFunction('ensure_env_metabot_home');
    const envFile = path.join(tmp, '.env');
    fs.writeFileSync(envFile, 'API_PORT=9100\n');

    const script = `${LOG_STUBS}
METABOT_HOME="${tmp}"
${fn}
ensure_env_metabot_home
ensure_env_metabot_home
ensure_env_metabot_home
`;
    const out = runBash(script);
    const lines = fs.readFileSync(envFile, 'utf-8').split('\n');
    const homeLines = lines.filter((l) => l.startsWith('METABOT_HOME='));

    // Idempotent: three runs, exactly one line.
    expect(homeLines).toEqual([`METABOT_HOME=${tmp}`]);
    expect(out).toContain('left untouched');
  });

  it('never overwrites a METABOT_HOME the user edited by hand', () => {
    const fn = extractBashFunction('ensure_env_metabot_home');
    const envFile = path.join(tmp, '.env');
    fs.writeFileSync(envFile, 'METABOT_HOME=/opt/custom-metabot\n');

    runBash(`${LOG_STUBS}\nMETABOT_HOME="${tmp}"\n${fn}\nensure_env_metabot_home\n`);

    expect(fs.readFileSync(envFile, 'utf-8')).toBe('METABOT_HOME=/opt/custom-metabot\n');
  });

  it('exports METABOT_HOME to shell rc files without stacking duplicates', () => {
    const sedI = extractBashFunction('sed_i');
    const region = extractBashRegion(RC_REGION_START, RC_REGION_END);
    const fakeHome = path.join(tmp, 'home');
    fs.mkdirSync(fakeHome);
    fs.writeFileSync(path.join(fakeHome, '.bashrc'), '# existing bashrc\n');
    fs.writeFileSync(path.join(fakeHome, '.zshrc'), '# existing zshrc\n');

    const script = `${LOG_STUBS}
OS="Linux"
HOME="${fakeHome}"
METABOT_HOME="${tmp}/metabot"
${sedI}
${region}
${region}
${region}
`;
    runBash(script);

    for (const rc of ['.bashrc', '.zshrc']) {
      const contents = fs.readFileSync(path.join(fakeHome, rc), 'utf-8');
      const exports = contents.split('\n').filter((l) => l.startsWith('export METABOT_HOME='));
      expect(exports).toEqual([`export METABOT_HOME="${tmp}/metabot"`]);
    }
  });

  it('replaces a stale export instead of appending next to it', () => {
    const sedI = extractBashFunction('sed_i');
    const region = extractBashRegion(RC_REGION_START, RC_REGION_END);
    const fakeHome = path.join(tmp, 'home');
    fs.mkdirSync(fakeHome);
    fs.writeFileSync(path.join(fakeHome, '.bashrc'), 'export METABOT_HOME="/old/path"\n');

    runBash(`${LOG_STUBS}\nOS="Linux"\nHOME="${fakeHome}"\nMETABOT_HOME="${tmp}/metabot"\n${sedI}\n${region}\n`);

    const contents = fs.readFileSync(path.join(fakeHome, '.bashrc'), 'utf-8');
    expect(contents).not.toContain('/old/path');
    expect(contents).toContain(`export METABOT_HOME="${tmp}/metabot"`);
  });

  it('persists METABOT_HOME unconditionally, not only for non-default paths', () => {
    // The old guards limited persistence to installs whose path differed from
    // the default, which left $HOME/metabot installs without the variable.
    expect(SH_SOURCE).not.toContain('if [[ "$METABOT_HOME" != "$DEFAULT_METABOT_HOME" ]]; then');
    expect(PS_SOURCE).not.toContain('if ($MetabotHome -ne $DefaultMetabotHome) {');
    expect(PS_SOURCE).toContain('[System.Environment]::SetEnvironmentVariable("METABOT_HOME", $MetabotHome, "User")');
  });

  it('appends METABOT_HOME to a pre-existing .env on Windows too', () => {
    expect(PS_SOURCE).toContain("$existingEnv -match '(?m)^\\s*METABOT_HOME='");
    expect(PS_SOURCE).toContain('METABOT_HOME already set in $EnvFile');
  });
});
