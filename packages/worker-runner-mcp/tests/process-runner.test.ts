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
        HTTP_PROXY: 'http://proxy.example.test:8080',
        HTTPS_PROXY: 'http://proxy.example.test:8080',
        http_proxy: 'http://proxy.example.test:8080',
        https_proxy: 'http://proxy.example.test:8080',
        NO_PROXY: 'localhost,127.0.0.1',
        no_proxy: 'localhost,127.0.0.1',
        METABOT_WORKER_CALLBACK_URL: 'https://callback.invalid',
        METABOT_WORKER_CALLBACK_TOKEN: 'callback-secret',
        METABOT_ARC_PROXY_URL: 'http://127.0.0.1:9000/mcp',
        METABOT_ARC_PROXY_CAPABILITY_FILE: '/run/secrets/arc-capability',
        OPENAI_API_KEY: 'api-secret',
        ANTHROPIC_AUTH_TOKEN: 'auth-secret',
        METABOT_ADMIN_ROLE: 'admin',
        METABOT_CALLBACK_URL: 'https://callback.invalid',
        METABOT_CAPABILITY_SET: 'worker-admin',
        METABOT_PRINCIPAL_ROLE: 'pm',
        HTTP_PROXY_PASSWORD: 'proxy-secret',
        UNLISTED_VALUE: 'not-allowed',
      },
      [
        'CUSTOM_SAFE',
        'HTTP_PROXY',
        'HTTPS_PROXY',
        'http_proxy',
        'https_proxy',
        'NO_PROXY',
        'no_proxy',
        'METABOT_WORKER_CALLBACK_URL',
        'METABOT_WORKER_CALLBACK_TOKEN',
        'METABOT_ARC_PROXY_URL',
        'METABOT_ARC_PROXY_CAPABILITY_FILE',
        'OPENAI_API_KEY',
        'ANTHROPIC_AUTH_TOKEN',
        'METABOT_ADMIN_ROLE',
        'METABOT_CALLBACK_URL',
        'METABOT_CAPABILITY_SET',
        'METABOT_PRINCIPAL_ROLE',
        'HTTP_PROXY_PASSWORD',
      ],
    );

    expect(childEnv).toEqual({
      PATH: '/usr/bin',
      LANG: 'C.UTF-8',
      CUSTOM_SAFE: 'allowed',
      HTTP_PROXY: 'http://proxy.example.test:8080',
      HTTPS_PROXY: 'http://proxy.example.test:8080',
      http_proxy: 'http://proxy.example.test:8080',
      https_proxy: 'http://proxy.example.test:8080',
      NO_PROXY: 'localhost,127.0.0.1',
      no_proxy: 'localhost,127.0.0.1',
    });
  });

  it('rejects a Kimi prompt above the argv safety limit', () => {
    expect(() =>
      runner.buildCommand({
        id: 'wrk-large',
        launchId: 'launch-large',
        engine: 'kimi',
        workdir: '/tmp/project',
        prompt: 'x'.repeat(16_385),
      }),
    ).toThrow('16384-byte argv safety limit');
  });
});
