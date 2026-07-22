import { spawnSync } from 'node:child_process';
import process from 'node:process';

export interface TypecheckProject {
  label: string;
  tsconfig: string;
}

export interface TypecheckFailure {
  label: string;
  tsconfig: string;
  message: string;
}

export interface TypecheckGateResult {
  checkedProjects: TypecheckProject[];
  failures: TypecheckFailure[];
  ok: boolean;
}

export interface RunRootTypecheckOptions {
  cwd?: string;
  projects?: TypecheckProject[];
  runner?: TypeScriptProjectRunner;
}

export type TypeScriptProjectRunner = (project: TypecheckProject, cwd: string) => void;

export const ROOT_TYPECHECK_PROJECTS: TypecheckProject[] = [
  { label: 'bridge', tsconfig: 'tsconfig.bridge.json' },
  { label: 'packages/cli-core', tsconfig: 'packages/cli-core/tsconfig.json' },
  { label: 'packages/metamemory', tsconfig: 'packages/metamemory/tsconfig.json' },
  { label: 'packages/skill-hub', tsconfig: 'packages/skill-hub/tsconfig.json' },
  { label: 'packages/cli', tsconfig: 'packages/cli/tsconfig.json' },
  { label: 'packages/server', tsconfig: 'packages/server/tsconfig.json' },
  { label: 'packages/web-ui', tsconfig: 'packages/web-ui/tsconfig.json' },
];

export function runRootTypecheck(options: RunRootTypecheckOptions = {}): TypecheckGateResult {
  const cwd = options.cwd ?? process.cwd();
  const projects = options.projects ?? ROOT_TYPECHECK_PROJECTS;
  const runner = options.runner ?? runTypeScriptNoEmit;
  const failures: TypecheckFailure[] = [];

  for (const project of projects) {
    try {
      runner(project, cwd);
    } catch (err) {
      failures.push({
        label: project.label,
        tsconfig: project.tsconfig,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    checkedProjects: projects,
    failures,
    ok: failures.length === 0,
  };
}

export function runTypecheckCli(): number {
  const result = runRootTypecheck();
  if (result.ok) {
    process.stdout.write(`Root typecheck passed for ${result.checkedProjects.length} TypeScript projects.\n`);
    return 0;
  }

  process.stderr.write('Root typecheck failed:\n');
  for (const failure of result.failures) {
    process.stderr.write(`- ${failure.label} (${failure.tsconfig})\n`);
    process.stderr.write(`${indent(failure.message.trimEnd())}\n`);
  }
  return 1;
}

function runTypeScriptNoEmit(project: TypecheckProject, cwd: string): void {
  const result = spawnSync(tscBin(), ['-p', project.tsconfig, '--noEmit', '--pretty', 'false'], {
    cwd,
    encoding: 'utf8',
  });
  if (result.status === 0) return;

  const output = [result.stdout, result.stderr, result.error?.message].filter(Boolean).join('\n').trim();
  throw new Error(output || `tsc exited with status ${result.status ?? 'unknown'}`);
}

function tscBin(): string {
  return process.platform === 'win32' ? 'tsc.cmd' : 'tsc';
}

function indent(value: string): string {
  return value
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}
