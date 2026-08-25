import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConnectorError } from '../src/errors.js';
import {
  PUBLIC_MATERIAL_MODES,
  readProtectedFile,
  readProtectedPublicKey,
  readProtectedSecret,
} from '../src/protected-file.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'mcp-connector-protected-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeSecret(name: string, content: string, mode = 0o600): string {
  const filePath = path.join(root, name);
  writeFileSync(filePath, content, { mode });
  chmodSync(filePath, mode);
  return filePath;
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof ConnectorError ? error.code : `unexpected:${String(error)}`;
  }
  return 'no-error';
}

describe('readProtectedFile', () => {
  it('reads a 0600 regular file owned by the current uid', () => {
    const filePath = writeSecret('capability.token', 'payload.signature\n');
    expect(readProtectedFile(filePath)).toBe('payload.signature\n');
  });

  it('requires an absolute path', () => {
    expect(codeOf(() => readProtectedFile('capability.token'))).toBe('CREDENTIAL_UNSAFE');
  });

  it('reports a missing file distinctly from an unsafe one', () => {
    expect(codeOf(() => readProtectedFile(path.join(root, 'absent.token')))).toBe('CREDENTIAL_MISSING');
  });

  it('refuses a symlink even when its target is safe', () => {
    const real = writeSecret('real.token', 'value');
    const link = path.join(root, 'link.token');
    symlinkSync(real, link);
    expect(codeOf(() => readProtectedFile(link))).toBe('CREDENTIAL_UNSAFE');
  });

  it('refuses a directory and other non-regular nodes', () => {
    const dir = path.join(root, 'dir.token');
    mkdirSync(dir, { mode: 0o700 });
    expect(codeOf(() => readProtectedFile(dir))).toBe('CREDENTIAL_UNSAFE');
  });

  it('refuses group- or world-readable modes', () => {
    expect(codeOf(() => readProtectedFile(writeSecret('loose.token', 'value', 0o644)))).toBe('CREDENTIAL_UNSAFE');
    expect(codeOf(() => readProtectedFile(writeSecret('group.token', 'value', 0o640)))).toBe('CREDENTIAL_UNSAFE');
  });

  it('refuses a file larger than the ceiling', () => {
    const filePath = writeSecret('big.token', 'x'.repeat(64));
    expect(codeOf(() => readProtectedFile(filePath, { maxBytes: 32 }))).toBe('CREDENTIAL_TOO_LARGE');
  });

  it('enforces containment on canonical paths', () => {
    const contained = path.join(root, 'runtime');
    mkdirSync(contained, { mode: 0o700 });
    const inside = path.join(contained, 'inside.token');
    writeFileSync(inside, 'value', { mode: 0o600 });
    expect(readProtectedFile(inside, { containedIn: contained })).toBe('value');

    const outside = writeSecret('outside.token', 'value');
    expect(codeOf(() => readProtectedFile(outside, { containedIn: contained }))).toBe('CREDENTIAL_UNSAFE');
  });

  it('refuses a symlink that would escape containment', () => {
    const contained = path.join(root, 'runtime');
    mkdirSync(contained, { mode: 0o700 });
    const outside = writeSecret('escaped.token', 'value');
    const link = path.join(contained, 'escape.token');
    symlinkSync(outside, link);
    expect(codeOf(() => readProtectedFile(link, { containedIn: contained }))).toBe('CREDENTIAL_UNSAFE');
  });
});

describe('readProtectedSecret', () => {
  it('trims surrounding whitespace', () => {
    expect(readProtectedSecret(writeSecret('trim.token', '  abc.def \n'))).toBe('abc.def');
  });

  it('refuses an empty file rather than returning an empty credential', () => {
    expect(codeOf(() => readProtectedSecret(writeSecret('empty.token', '   \n')))).toBe('CREDENTIAL_EMPTY');
  });

  it('refuses a multi-line file instead of silently taking the first line', () => {
    expect(codeOf(() => readProtectedSecret(writeSecret('multi.token', 'first\nsecond\n')))).toBe('CREDENTIAL_UNSAFE');
  });
});

describe('public material modes', () => {
  it('accepts a verification key at the ordinary 0644 an operator would create', () => {
    const file = writeSecret('verify.pub', 'ssh-ed25519 AAAA', 0o644);
    expect(readProtectedPublicKey(file, { label: 'verification key' })).toBe('ssh-ed25519 AAAA');
  });

  it('accepts every mode that leaves the file unwritable by group and other', () => {
    for (const mode of PUBLIC_MATERIAL_MODES) {
      const file = writeSecret(`verify-${mode.toString(8)}.pub`, 'material', mode);
      expect(readProtectedPublicKey(file), mode.toString(8)).toBe('material');
    }
  });

  it('still refuses a group- or world-writable verification key', () => {
    for (const mode of [0o660, 0o666, 0o622, 0o606]) {
      const file = writeSecret(`writable-${mode.toString(8)}.pub`, 'material', mode);
      expect(() => readProtectedPublicKey(file), mode.toString(8)).toThrow(/permissions are/);
    }
  });

  it('keeps secrets on the single 0600 mode', () => {
    const file = writeSecret('secret-644', 'token-value', 0o644);
    expect(() => readProtectedSecret(file, { label: 'capability' })).toThrow(/expected 600/);
  });
});
