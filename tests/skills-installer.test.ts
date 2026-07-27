import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installSkillsToWorkDir } from '../src/api/skills-installer.js';

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
} as any;

let cleanupDirs: string[] = [];

afterEach(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
  cleanupDirs = [];
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

describe('skills installer', () => {
  it('mirrors bundled skills into Claude and Codex project directories and deploys AGENTS.md', () => {
    const priorHome = process.env.HOME;
    const home = tempDir('metabot-home-');
    const workDir = tempDir('metabot-work-');
    try {
      process.env.HOME = home;
      mkdirSync(join(home, '.claude/skills'), { recursive: true });

      installSkillsToWorkDir(workDir, logger);

      // `metabot` is in the default COMMON_SKILLS list, so its bundled SKILL.md
      // must land in both Claude and Codex project directories.
      expect(readFileSync(join(workDir, '.claude/skills/metabot/SKILL.md'), 'utf-8')).toContain('metabot');
      expect(readFileSync(join(workDir, '.codex/skills/metabot/SKILL.md'), 'utf-8')).toContain('metabot');
      expect(readFileSync(join(workDir, '.claude/skills/metabot-todos/SKILL.md'), 'utf-8')).toContain('metabot-todos');
      expect(readFileSync(join(workDir, '.codex/skills/metabot-todos/SKILL.md'), 'utf-8')).toContain('metabot-todos');
      expect(readFileSync(join(workDir, 'AGENTS.md'), 'utf-8')).toContain('MetaBot Workspace');

      // `metaskill` and `metaschedule` are opt-in: not deployed unless the
      // user has placed them in ~/.claude/skills/. Confirm they did not slip
      // into the default install.
      expect(() => readFileSync(join(workDir, '.claude/skills/metaskill/SKILL.md'), 'utf-8')).toThrow();
      expect(() => readFileSync(join(workDir, '.claude/skills/metaschedule/SKILL.md'), 'utf-8')).toThrow();

      // `metamemory` and `skill-hub` now live in metabot-core and are NOT
      // bundled here. Confirm the install does not produce them.
      expect(() => readFileSync(join(workDir, '.claude/skills/metamemory/SKILL.md'), 'utf-8')).toThrow();
      expect(() => readFileSync(join(workDir, '.claude/skills/skill-hub/SKILL.md'), 'utf-8')).toThrow();
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
    }
  });
});
