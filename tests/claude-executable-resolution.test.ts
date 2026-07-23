import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveClaudePath } from '../src/engines/claude/resolve-executable.js';

const scratchDirs: string[] = [];

function executableAt(filePath: string): string {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, '#!/bin/sh\nexit 0\n');
  chmodSync(filePath, 0o755);
  return filePath;
}

function scratchDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'metabot-claude-path-'));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveClaudePath', () => {
  it('uses a valid explicit executable path first', () => {
    const executable = executableAt(path.join(scratchDir(), 'custom-claude'));

    expect(resolveClaudePath({
      explicitPath: executable,
      env: { PATH: '' },
      homeDir: scratchDir(),
      platform: 'linux',
    })).toBe(executable);
  });

  it('finds claude on PATH', () => {
    const binDir = path.join(scratchDir(), 'bin');
    const executable = executableAt(path.join(binDir, 'claude'));

    expect(resolveClaudePath({
      env: { PATH: binDir },
      homeDir: scratchDir(),
      platform: 'linux',
    })).toBe(executable);
  });

  it('finds the user-local install when service PATH omits it', () => {
    const homeDir = scratchDir();
    const executable = executableAt(path.join(homeDir, '.local', 'bin', 'claude'));

    expect(resolveClaudePath({
      env: { PATH: '/usr/bin:/bin' },
      homeDir,
      platform: 'linux',
    })).toBe(executable);
  });

  it('preserves an invalid explicit path when no executable can be found', () => {
    const missing = path.join(scratchDir(), 'missing-claude');

    expect(resolveClaudePath({
      explicitPath: missing,
      env: { PATH: '' },
      homeDir: scratchDir(),
      platform: 'win32',
    })).toBe(missing);
  });
});
