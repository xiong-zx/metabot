import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Re-running install.sh over an older install must remove the skill bundles
 * that are no longer shipped (metaskill became opt-in; metamemory / skill-hub /
 * memory were folded into the unified `metabot` skill). Without the cleanup the
 * stale copies keep being discovered by Claude/Codex and shadow the new one.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL_SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'install.sh'), 'utf-8');
const POWERSHELL_INSTALL_SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'install.ps1'), 'utf-8');

/** Slice install.sh between two markers so the test runs the shipped code. */
function extractBlock(startMarker: string, endMarker: string): string {
  const start = INSTALL_SOURCE.indexOf(startMarker);
  if (start === -1) throw new Error(`Missing "${startMarker}" in install.sh`);
  const end = INSTALL_SOURCE.indexOf(endMarker, start);
  if (end === -1) throw new Error(`Missing "${endMarker}" after "${startMarker}" in install.sh`);
  return INSTALL_SOURCE.slice(start, end);
}

const CLEANUP_BLOCK = extractBlock('# Clean up legacy metaskill skill', 'META_SKILL_SOURCES=(');

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function runCleanup(existingSkills: string[]): { skillsDir: string; output: string } {
  const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-skills-'));
  tempDirs.push(skillsDir);
  for (const skill of existingSkills) {
    fs.mkdirSync(path.join(skillsDir, skill), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, skill, 'SKILL.md'), `# ${skill}\n`);
  }

  const script = [
    'set -euo pipefail',
    'info() { echo "INFO $*"; }',
    `SKILLS_DIR=${JSON.stringify(skillsDir)}`,
    CLEANUP_BLOCK,
  ].join('\n');

  const output = execFileSync('bash', ['-c', script], { encoding: 'utf-8' });
  return { skillsDir, output };
}

describe('install.sh legacy skill cleanup', () => {
  it('removes the legacy metaskill bundle and says why', () => {
    const { skillsDir, output } = runCleanup(['metaskill', 'metabot']);

    expect(fs.existsSync(path.join(skillsDir, 'metaskill'))).toBe(false);
    expect(output).toContain('Removed legacy metaskill skill');
  });

  it('removes the pre-consolidation metamemory / skill-hub / memory bundles', () => {
    const { skillsDir, output } = runCleanup(['metamemory', 'skill-hub', 'memory', 'metabot']);

    for (const legacy of ['metamemory', 'skill-hub', 'memory']) {
      expect(fs.existsSync(path.join(skillsDir, legacy))).toBe(false);
    }
    // skill-hub's replacement subcommand is `metabot skills`, not `metabot skill-hub`.
    expect(output).toContain('use `metabot skills` instead');
    expect(output).toContain('use `metabot memory` instead');
  });

  it('leaves currently-shipped skills alone', () => {
    const { skillsDir } = runCleanup(['metabot', 'metabot-team', 'voice', 'metaskill']);

    for (const kept of ['metabot', 'metabot-team', 'voice']) {
      expect(fs.existsSync(path.join(skillsDir, kept, 'SKILL.md'))).toBe(true);
    }
  });

  it('is a no-op on a fresh install', () => {
    const { skillsDir, output } = runCleanup([]);

    expect(fs.readdirSync(skillsDir)).toEqual([]);
    expect(output.trim()).toBe('');
  });

  it('keeps the matching cleanup in install.ps1', () => {
    expect(POWERSHELL_INSTALL_SOURCE).toContain('metaskill');
  });
});
