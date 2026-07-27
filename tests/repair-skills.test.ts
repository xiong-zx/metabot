import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const METABOT_BIN = path.join(REPO_ROOT, 'bin', 'metabot');
const BUNDLED = ['metabot', 'metabot-team', 'metabot-todos', 'voice'];

let tmp: string;
let metabotHome: string; // acts as METABOT_HOME (holds bundled skill sources)
let userHome: string; // acts as HOME (skill roots are deployed here)
let codexHome: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-repair-')));
  metabotHome = path.join(tmp, 'metabot-home');
  userHome = path.join(tmp, 'user-home');
  codexHome = path.join(userHome, '.codex');
  fs.mkdirSync(userHome, { recursive: true });
  for (const rel of [
    'packages/skills/metabot',
    'packages/skills/metabot-team',
    'packages/skills/metabot-todos',
    'src/skills/voice',
  ]) {
    fs.mkdirSync(path.join(metabotHome, rel), { recursive: true });
    fs.writeFileSync(path.join(metabotHome, rel, 'SKILL.md'), `# ${rel}\n`);
  }
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function runMetabot(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync('bash', [METABOT_BIN, ...args], {
      encoding: 'utf-8',
      env: { ...process.env, HOME: userHome, CODEX_HOME: codexHome, METABOT_HOME: metabotHome },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (e: any) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

function skillRoots(): string[] {
  return [
    path.join(userHome, '.claude', 'skills'),
    path.join(codexHome, 'skills'),
    path.join(userHome, '.agents', 'skills'),
  ];
}

describe('metabot repair-skills (end-to-end)', () => {
  it('deploys the four bundled skills into all three skill roots, idempotently', () => {
    expect(runMetabot(['repair-skills']).code).toBe(0);
    expect(runMetabot(['repair-skills']).code).toBe(0); // idempotent second pass

    for (const root of skillRoots()) {
      for (const skill of BUNDLED) {
        expect(fs.existsSync(path.join(root, skill, 'SKILL.md'))).toBe(true);
      }
    }
  });

  it('--dry-run reports intent but writes nothing', () => {
    const { code, out } = runMetabot(['repair-skills', '--dry-run']);
    expect(code).toBe(0);
    expect(out).toContain('[dry-run]');
    expect(fs.existsSync(path.join(userHome, '.claude', 'skills', 'metabot'))).toBe(false);
  });

  it('fails loudly on a stale/incomplete checkout (missing sentinel source)', () => {
    fs.rmSync(path.join(metabotHome, 'packages', 'skills', 'metabot'), { recursive: true, force: true });
    const { code, out } = runMetabot(['repair-skills']);
    expect(code).not.toBe(0);
    expect(out).toContain('Bundled skill source not found');
  });

  it('does not restart services or edit .env (no side effects beyond skill roots)', () => {
    runMetabot(['repair-skills']);
    // No .env written into either home.
    expect(fs.existsSync(path.join(userHome, '.env'))).toBe(false);
    expect(fs.existsSync(path.join(metabotHome, '.env'))).toBe(false);
  });
});

describe('metabot doctor bundled-skill + home-instruction diagnostics (end-to-end)', () => {
  function doctorJson(): any {
    const { code, out } = runMetabot(['doctor', '--json']);
    expect(code).toBe(0);
    return JSON.parse(out);
  }
  function findCheck(report: any, name: string) {
    return (report.checks || []).find((c: any) => c.name === name);
  }

  it('reports the missing skill + missing home instructions, then clears after repair', () => {
    // Fresh user HOME: no skills deployed; METABOT_HOME has no CLAUDE.md/AGENTS.md.
    let report = doctorJson();
    expect(report.metabotHome).toBe(metabotHome);
    expect(typeof report.cwd === 'string' || report.cwd === null).toBe(true);

    const bundled = findCheck(report, 'bundled_skills');
    expect(bundled).toBeTruthy();
    expect(bundled.ok).toBe(false);
    expect(bundled.recommendedAction).toContain('metabot repair-skills');

    const home = findCheck(report, 'home_instructions');
    expect(home).toBeTruthy();
    expect(home.ok).toBe(false);
    expect(home.data.instructionModel.toLowerCase()).toContain('local (working directory) wins');

    // Heal skills + create the global rule files.
    expect(runMetabot(['repair-skills']).code).toBe(0);
    fs.writeFileSync(path.join(metabotHome, 'CLAUDE.md'), '# global rules\n');
    fs.writeFileSync(path.join(metabotHome, 'AGENTS.md'), '# global rules\n');

    report = doctorJson();
    expect(findCheck(report, 'bundled_skills').ok).toBe(true);
    expect(findCheck(report, 'home_instructions').ok).toBe(true);
  }, 120000);
});
