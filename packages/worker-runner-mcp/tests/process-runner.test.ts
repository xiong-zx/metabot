import { describe, expect, it } from 'vitest';
import { NodeCliProcessRunner, buildSanitizedEnv } from '../src/process-runner.js';

describe('NodeCliProcessRunner command construction', () => {
  const runner = new NodeCliProcessRunner({
    executables: { codex: '/bin/codex', claude: '/bin/claude', kimi: '/bin/kimi' },
  });

  it('uses one-shot Codex exec with stdin and explicit cwd sandbox policy', () => {
    const command = runner.buildCommand({
      id: 'wrk-1',
      launchId: 'launch-1',
      engine: 'codex',
      model: 'gpt-test',
      workdir: '/tmp/project',
      prompt: 'do work',
    });
    expect(command).toMatchObject({ command: '/bin/codex', stdin: 'do work' });
    expect(command.args).toEqual(
      expect.arrayContaining(['exec', '--json', '--sandbox', 'workspace-write', '--model', 'gpt-test', '-']),
    );
  });

  it('uses one-shot Claude print with stdin', () => {
    const command = runner.buildCommand({
      id: 'wrk-2',
      launchId: 'launch-2',
      engine: 'claude',
      workdir: '/tmp/project',
      prompt: 'do work',
    });
    expect(command).toMatchObject({ command: '/bin/claude', stdin: 'do work' });
    expect(command.args).toEqual(
      expect.arrayContaining(['--print', '--output-format', 'text', '--permission-mode', 'auto']),
    );
  });

  it('uses one-shot Kimi prompt mode and forwards only an explicit generic contract', () => {
    const command = runner.buildCommand({
      id: 'wrk-3',
      launchId: 'launch-3',
      engine: 'kimi',
      workdir: '/tmp/project',
      prompt: 'do work',
      outputContract: { format: 'json', jsonSchema: { type: 'object' } },
    });
    expect(command.command).toBe('/bin/kimi');
    expect(command.args).toEqual(
      expect.arrayContaining(['--prompt', expect.stringContaining('Caller-supplied generic output contract')]),
    );
    expect(command.args.join(' ')).not.toContain('results.json');
  });

  it('builds a child environment from safe names only and rejects secret names even when allowlisted', () => {
    const childEnv = buildSanitizedEnv(
      {
        PATH: '/usr/bin',
        LANG: 'C.UTF-8',
        CUSTOM_SAFE: 'allowed',
        METABOT_WORKER_CALLBACK_URL: 'https://callback.invalid',
        METABOT_WORKER_CALLBACK_TOKEN: 'callback-secret',
        OPENAI_API_KEY: 'api-secret',
        ANTHROPIC_AUTH_TOKEN: 'auth-secret',
        UNLISTED_VALUE: 'not-allowed',
      },
      [
        'CUSTOM_SAFE',
        'METABOT_WORKER_CALLBACK_URL',
        'METABOT_WORKER_CALLBACK_TOKEN',
        'OPENAI_API_KEY',
        'ANTHROPIC_AUTH_TOKEN',
      ],
    );

    expect(childEnv).toEqual({ PATH: '/usr/bin', LANG: 'C.UTF-8', CUSTOM_SAFE: 'allowed' });
  });
});
