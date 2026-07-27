import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Smoke test for packages/server/scripts/pack-metabot.sh.
//
// The script reaches up from packages/server/scripts/ to the repo root, so we
// just invoke it as-is and inspect the published artifacts. Tarball + bootstrap
// land under packages/server/static/install/. We snapshot any pre-existing
// outputs and restore them after the test so a developer running this against
// a previously-built repo doesn't lose their tarball.

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(PKG_DIR, 'scripts', 'pack-metabot.sh');
const OUT_DIR = path.join(PKG_DIR, 'static', 'install');
const TARBALL_PATH = path.join(OUT_DIR, 'latest.tgz');
const BOOTSTRAP_PATH = path.join(OUT_DIR, 'install.sh');

let preExistingTarball: Buffer | undefined;
let preExistingBootstrap: Buffer | undefined;
let preExistingDir = false;
let tarListing: string = '';
let scriptRan = false;

beforeAll(() => {
  if (fs.existsSync(OUT_DIR)) {
    preExistingDir = true;
    if (fs.existsSync(TARBALL_PATH)) preExistingTarball = fs.readFileSync(TARBALL_PATH);
    if (fs.existsSync(BOOTSTRAP_PATH)) preExistingBootstrap = fs.readFileSync(BOOTSTRAP_PATH);
  }

  // Run the pack script. tar / rsync / bash must be available; they are on
  // every supported dev host (Linux + macOS) and the CI image.
  execSync(`bash ${JSON.stringify(SCRIPT)}`, {
    stdio: 'pipe',
    // Pack script writes a few lines to stdout; capture them for failure
    // diagnostics but don't pollute test output on success.
  });
  scriptRan = true;

  tarListing = execSync(`tar tzf ${JSON.stringify(TARBALL_PATH)}`, { encoding: 'utf-8' });
}, 60_000);

afterAll(() => {
  if (!scriptRan) return;
  if (preExistingTarball !== undefined) {
    fs.writeFileSync(TARBALL_PATH, preExistingTarball);
  } else if (fs.existsSync(TARBALL_PATH)) {
    fs.unlinkSync(TARBALL_PATH);
  }
  if (preExistingBootstrap !== undefined) {
    fs.writeFileSync(BOOTSTRAP_PATH, preExistingBootstrap);
  } else if (fs.existsSync(BOOTSTRAP_PATH)) {
    fs.unlinkSync(BOOTSTRAP_PATH);
  }
  if (!preExistingDir) {
    try { fs.rmdirSync(OUT_DIR); } catch { /* keep if non-empty */ }
  }
});

describe('pack-metabot.sh', () => {
  it('publishes a non-empty gzip tarball at static/install/latest.tgz', () => {
    expect(fs.existsSync(TARBALL_PATH)).toBe(true);
    const stat = fs.statSync(TARBALL_PATH);
    expect(stat.size).toBeGreaterThan(1024);
    // gzip magic — atomic-rename target landed.
    const head = fs.readFileSync(TARBALL_PATH).subarray(0, 2);
    expect(head[0]).toBe(0x1f);
    expect(head[1]).toBe(0x8b);
  });

  it('publishes the bootstrap install.sh at static/install/install.sh', () => {
    expect(fs.existsSync(BOOTSTRAP_PATH)).toBe(true);
    const head = fs.readFileSync(BOOTSTRAP_PATH, 'utf-8').slice(0, 20);
    expect(head.startsWith('#!/usr/bin/env bash')).toBe(true);
    const mode = fs.statSync(BOOTSTRAP_PATH).mode & 0o111;
    expect(mode).not.toBe(0);
  });

  it('bootstrap always extracts the tarball (no .git delegation that would `git pull` stale GitHub mirrors)', () => {
    const src = fs.readFileSync(BOOTSTRAP_PATH, 'utf-8');
    // Look at non-comment lines only — explanatory prose may mention these
    // patterns even when the active code doesn't.
    const codeOnly = src
      .split('\n')
      .map((l) => l.replace(/(^|[^\\])#.*$/, '$1'))
      .filter((l) => l.trim().length > 0)
      .join('\n');

    // Active code must set the env gate so install.sh skips Phase 2 entirely.
    expect(codeOnly).toMatch(/export\s+METABOT_SKIP_GIT=1/);
    // No code path may delegate to the in-tree install.sh based on .git/ — that
    // would send GitHub-clone users into a stale-mirror git pull.
    expect(codeOnly).not.toMatch(
      /-d\s+"\$METABOT_HOME\/\.git"[\s\S]{0,200}exec\s+bash\s+"\$METABOT_HOME\/install\.sh"/,
    );
    // `--keep-newer-files` is a footgun with our deterministic
    // `--mtime='UTC 2026-01-01'`: local files modified after that date
    // silently survive, defeating the overlay refresh.
    expect(codeOnly).not.toContain('--keep-newer-files');
  });

  it('tarball includes the bot-host runtime entrypoints', () => {
    // Phase 2 / 3 entry points the bootstrap exec's into.
    expect(tarListing).toMatch(/(^|\n)\.?\/?install\.sh\b/);
    expect(tarListing).toMatch(/(^|\n)\.?\/?ecosystem\.config\.cjs\b/);
    expect(tarListing).toMatch(/(^|\n)\.?\/?package\.json\b/);
    expect(tarListing).toMatch(/(^|\n)\.?\/?package-lock\.json\b/);
    expect(tarListing).toMatch(/(^|\n)\.?\/?bin\/metabot\b/);
  });

  it('tarball includes the four bot-host workspaces', () => {
    for (const ws of ['cli', 'cli-core', 'metamemory', 'skill-hub']) {
      expect(tarListing).toContain(`packages/${ws}/package.json`);
    }
  });

  it('tarball includes the packaged skill bundles', () => {
    expect(tarListing).toContain('packages/skills/metabot/SKILL.md');
    expect(tarListing).toContain('packages/skills/metabot-team/SKILL.md');
    expect(tarListing).toContain('packages/skills/metabot-todos/SKILL.md');
    expect(tarListing).toContain('packages/skills/metabot-todos/scripts/todo-display.mjs');
  });

  it('tarball includes engine sources and workspace skills', () => {
    expect(tarListing).toMatch(/(^|\n)\.?\/?src\//);
    // Voice skill is bundled inside src/skills/ — covered by the prefix match
    // above, but call it out explicitly to guard against future src/ slimming.
    expect(tarListing).toContain('src/skills/voice/SKILL.md');
  });

  it('tarball excludes central-only workspaces (server, web-ui)', () => {
    expect(tarListing).not.toMatch(/(^|\n)\.?\/?packages\/server\//);
    expect(tarListing).not.toMatch(/(^|\n)\.?\/?packages\/web-ui\//);
  });

  it('tarball excludes build artifacts and vcs dirs', () => {
    expect(tarListing).not.toMatch(/(^|\n)\.?\/?node_modules\//);
    expect(tarListing).not.toMatch(/(^|\n|\/)dist\//);
    expect(tarListing).not.toMatch(/(^|\n)\.?\/?\.git\//);
    expect(tarListing).not.toMatch(/\.tsbuildinfo\b/);
  });

  it('does not embed an internal default env unless explicitly requested', () => {
    expect(tarListing).not.toContain('.metabot-package/default.env');
  });

  it('can embed an internal default env when the pack env var is set', () => {
    const tmpDir = fs.mkdtempSync(path.join('/tmp', 'metabot-pack-secret-'));
    const secretPath = path.join(tmpDir, 'default.env');
    fs.writeFileSync(secretPath, 'METABOT_VOICE_REPLY_DEFAULT_ON=true\nVOLCENGINE_TTS_APPID=test-app\n');

    try {
      execSync(`METABOT_PACKAGE_DEFAULT_ENV_FILE=${JSON.stringify(secretPath)} bash ${JSON.stringify(SCRIPT)}`, {
        stdio: 'pipe',
      });
      const listing = execSync(`tar tzf ${JSON.stringify(TARBALL_PATH)}`, { encoding: 'utf-8' });
      expect(listing).toContain('.metabot-package/default.env');
      const content = execSync(`tar xOf ${JSON.stringify(TARBALL_PATH)} .metabot-package/default.env`, { encoding: 'utf-8' });
      expect(content).toContain('METABOT_VOICE_REPLY_DEFAULT_ON=true');
      expect(content).toContain('VOLCENGINE_TTS_APPID=test-app');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
