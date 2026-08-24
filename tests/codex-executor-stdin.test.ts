import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodexExecutor } from '../src/engines/codex/executor.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} } as any;

const prompts = [
  'ordinary prompt',
  '- leading dash prompt',
  '-- leading double-dash prompt',
  '--- leading triple-dash prompt',
];

describe.each([
  { name: 'fresh', sessionId: undefined },
  { name: 'resume', sessionId: 'session-existing' },
])('CodexExecutor stdin transport ($name)', ({ sessionId }) => {
  it.each(prompts)('keeps argv prompt-free and writes %j exactly to stdin', async (prompt) => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-codex-stdin-'));
    const executable = join(dir, 'codex');
    const argvFile = join(dir, 'argv');
    const stdinFile = join(dir, 'stdin');
    writeFileSync(
      executable,
      `#!/bin/sh
: > "$CAPTURE_ARGV"
for arg in "$@"; do
  printf '%s\\n' "$arg" >> "$CAPTURE_ARGV"
done
cat > "$CAPTURE_STDIN"
printf '%s\\n' '{"type":"thread.started","thread_id":"thread-stdin"}'
printf '%s\\n' '{"type":"item.completed","item":{"id":"msg-1","type":"agent_message","text":"done"}}'
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
`,
    );
    chmodSync(executable, 0o755);

    try {
      const executor = new CodexExecutor({
        codex: {
          executable,
          model: 'test-model',
          env: { CAPTURE_ARGV: argvFile, CAPTURE_STDIN: stdinFile },
        },
      } as any, logger);
      const messages: any[] = [];
      for await (const message of executor.execute({
        prompt,
        cwd: dir,
        sessionId,
        abortController: new AbortController(),
      })) {
        messages.push(message);
      }

      expect(messages.at(-1)).toMatchObject({ type: 'result', result: 'done', is_error: false });
      expect(readFileSync(stdinFile, 'utf8')).toBe(prompt);

      const argv = readFileSync(argvFile, 'utf8').trimEnd().split('\n');
      const tail = argv.slice(argv.indexOf('exec'));
      expect(tail).toEqual(sessionId
        ? ['exec', 'resume', '--json', '--skip-git-repo-check', sessionId, '-']
        : ['exec', '--json', '--color', 'never', '--skip-git-repo-check', '-']);
      expect(argv.join('\n')).not.toContain(prompt);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
