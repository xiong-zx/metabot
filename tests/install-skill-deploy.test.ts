import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SH_SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'install.sh'), 'utf-8');

/** Same extraction helper style as tests/install-metabot-home.test.ts. */
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

const BUNDLED = ['metabot', 'metabot-team', 'voice'];

let tmp: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-skill-deploy-')));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Build a minimal METABOT_HOME with the bundled skill source tree. */
function makeSkillSources(home: string) {
  for (const rel of [
    'packages/skills/metabot',
    'packages/skills/metabot-team',
    'src/skills/voice',
  ]) {
    fs.mkdirSync(path.join(home, rel), { recursive: true });
    fs.writeFileSync(path.join(home, rel, 'SKILL.md'), `# ${rel}\n`);
  }
}

function run(script: string): { code: number; out: string } {
  try {
    const out = execFileSync('bash', ['-c', script], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (e: any) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('deploy_bundled_skills (install.sh)', () => {
  const fn = () => extractBashFunction('deploy_bundled_skills');

  it('deploys all three bundled skills into every target root', () => {
    const home = path.join(tmp, 'home');
    makeSkillSources(home);
    const r1 = path.join(tmp, 'root1', 'skills');
    const r2 = path.join(tmp, 'root2', 'skills');

    const { code } = run(`${LOG_STUBS}\n${fn()}\ndeploy_bundled_skills "${home}" "${r1}" "${r2}"\n`);
    expect(code).toBe(0);

    for (const root of [r1, r2]) {
      for (const skill of BUNDLED) {
        expect(fs.existsSync(path.join(root, skill, 'SKILL.md'))).toBe(true);
      }
    }
  });

  it('is idempotent — three runs converge to exactly the three skills', () => {
    const home = path.join(tmp, 'home');
    makeSkillSources(home);
    const root = path.join(tmp, 'root', 'skills');
    const script = `${LOG_STUBS}\n${fn()}\ndeploy_bundled_skills "${home}" "${root}"\n`;

    expect(run(script).code).toBe(0);
    expect(run(script).code).toBe(0);
    expect(run(script).code).toBe(0);

    expect(fs.readdirSync(root).sort()).toEqual([...BUNDLED].sort());
    expect(fs.readFileSync(path.join(root, 'metabot', 'SKILL.md'), 'utf-8')).toBe('# packages/skills/metabot\n');
  });

  it('fails loudly (non-zero) and never claims success when the sentinel is missing', () => {
    const home = path.join(tmp, 'empty-home'); // no packages/skills/metabot
    fs.mkdirSync(home, { recursive: true });
    const root = path.join(tmp, 'root', 'skills');

    const { code, out } = run(`${LOG_STUBS}\n${fn()}\ndeploy_bundled_skills "${home}" "${root}"\n`);
    expect(code).not.toBe(0);
    expect(out).toContain('Bundled skill source not found');
    expect(out).not.toContain('OK: metabot installed');
    expect(fs.existsSync(path.join(root, 'metabot'))).toBe(false);
  });

  it('fails when a non-sentinel bundled source (voice) is missing', () => {
    const home = path.join(tmp, 'partial-home');
    // Sentinel + metabot-team present, but voice source absent.
    for (const rel of ['packages/skills/metabot', 'packages/skills/metabot-team']) {
      fs.mkdirSync(path.join(home, rel), { recursive: true });
      fs.writeFileSync(path.join(home, rel, 'SKILL.md'), `# ${rel}\n`);
    }
    const root = path.join(tmp, 'root', 'skills');

    const { code, out } = run(`${LOG_STUBS}\n${fn()}\ndeploy_bundled_skills "${home}" "${root}"\n`);
    expect(code).not.toBe(0);
    expect(out).toContain('Bundled skill source missing');
  });
});
