import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const METABOT_BIN = path.join(REPO_ROOT, 'bin', 'metabot');

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-update-test-'));
}

describe('metabot update source selection', () => {
  it('defaults to the internal package refresh even when .git exists', () => {
    const tmp = makeTempDir();
    const fakeBin = path.join(tmp, 'bin');
    const metabotHome = path.join(tmp, 'metabot');
    const marker = path.join(tmp, 'marker.txt');
    const curlArgs = path.join(tmp, 'curl-args.txt');

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.mkdirSync(path.join(metabotHome, '.git'), { recursive: true });
    fs.writeFileSync(path.join(metabotHome, 'install.sh'), '#!/usr/bin/env bash\n');
    fs.writeFileSync(
      path.join(fakeBin, 'curl'),
      [
        '#!/usr/bin/env bash',
        'printf "%s\\n" "$*" > "$CURL_ARGS_FILE"',
        'cat <<\'SH\'',
        '#!/usr/bin/env bash',
        'printf "package:%s\\n" "$METABOT_HOME" > "$MARKER"',
        'SH',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );

    execFileSync('bash', [METABOT_BIN, 'update'], {
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        METABOT_HOME: metabotHome,
        METABOT_CORE_URL: 'https://core.example.test',
        MARKER: marker,
        CURL_ARGS_FILE: curlArgs,
      },
      stdio: 'pipe',
    });

    expect(fs.readFileSync(marker, 'utf-8').trim()).toBe(`package:${metabotHome}`);
    expect(fs.readFileSync(curlArgs, 'utf-8')).toContain('https://core.example.test/install/install.sh');
  });

  it('documents the explicit developer git opt-in path', () => {
    const source = fs.readFileSync(METABOT_BIN, 'utf-8');
    expect(source).toContain('METABOT_UPDATE_SOURCE:-package');
    expect(source).toContain('metabot update --git');
    expect(source).toContain('exec "$METABOT_HOME/bin/metabot" update --git');
  });
});

describe('metabot doctor command', () => {
  it('is exposed as an agent-native diagnostic command', () => {
    const source = fs.readFileSync(METABOT_BIN, 'utf-8');
    expect(source).toContain('cmd_doctor()');
    expect(source).toContain('Usage: metabot doctor [--json]');
    expect(source).toContain('metabot doctor     Agent-readable runtime diagnostics (--json)');
    expect(source).toContain('doctor)       shift; cmd_doctor "$@" ;;');
    expect(source).toContain('"schemaVersion": 1');
  });

  it('checks Codex agent feature readiness', () => {
    const source = fs.readFileSync(METABOT_BIN, 'utf-8');
    expect(source).toContain('parse_codex_feature_list');
    expect(source).toContain('codex_agent_features');
    expect(source).toContain('"multi_agent"');
    expect(source).toContain('"memories"');
    expect(source).toContain('"skillsDirExists"');
    expect(source).toContain('"mcpServerCount"');
  });
});

describe('Codex install defaults', () => {
  it('initializes Codex multi-agent and memory defaults for Codex installs', () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, 'install.sh'), 'utf-8');
    expect(source).toContain('ensure_codex_agent_defaults()');
    expect(source).toContain('codex_config_set_feature_default "$config" "multi_agent" "true"');
    expect(source).toContain('codex_config_set_feature_default "$config" "memories" "true"');
    expect(source).toContain('codex_config_set_feature_default "$config" "guardian_approval" "true"');
    expect(source).toContain('mkdir -p "$codex_home/skills" "$codex_home/memories" "$codex_home/agents"');
  });
});
