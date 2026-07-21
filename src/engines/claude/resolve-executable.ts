import { accessSync, constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ResolveClaudePathOptions {
  explicitPath?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
}

function isExecutable(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    accessSync(candidate, platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(
  executable: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | undefined {
  const pathValue = env.PATH ?? env.Path ?? '';
  const separator = platform === 'win32' ? ';' : ':';
  const extensions = platform === 'win32'
    ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];

  for (const directory of pathValue.split(separator).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${executable}${extension.toLowerCase()}`);
      if (isExecutable(candidate, platform)) return candidate;
    }
  }
  return undefined;
}

/** Resolve Claude Code across service and interactive-shell installation layouts. */
export function resolveClaudePath(options: ResolveClaudePathOptions = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();
  const explicitPath = options.explicitPath ?? env.CLAUDE_EXECUTABLE_PATH;

  if (explicitPath && isExecutable(explicitPath, platform)) return explicitPath;

  const fromPath = findOnPath('claude', env, platform);
  if (fromPath) return fromPath;

  if (platform !== 'win32') {
    const candidates = [
      path.join(homeDir, '.local', 'bin', 'claude'),
      path.join(homeDir, '.npm-global', 'bin', 'claude'),
      '/usr/local/bin/claude',
      '/usr/bin/claude',
      '/opt/homebrew/bin/claude',
    ];
    for (const candidate of candidates) {
      if (isExecutable(candidate, platform)) return candidate;
    }
  }

  // Preserve an explicit invalid path so the spawn audit identifies the exact
  // misconfiguration. Otherwise let the process runner report a missing CLI.
  return explicitPath ?? 'claude';
}
