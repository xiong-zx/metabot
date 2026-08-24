import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConnectorError } from '../src/errors.js';
import { resolveConnectorTarget, type ConnectorDescriptor } from '../src/target.js';

const DESCRIPTOR: ConnectorDescriptor = {
  endpointEnvVar: 'FIXTURE_ENDPOINT',
  capabilityFileEnvVar: 'FIXTURE_CAPABILITY_FILE',
  serviceSecretFileEnvVar: 'FIXTURE_SERVICE_SECRET_FILE',
  audience: 'fixture',
};

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'mcp-connector-target-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeSecret(name: string, content: string): string {
  const filePath = path.join(root, name);
  writeFileSync(filePath, content, { mode: 0o600 });
  chmodSync(filePath, 0o600);
  return filePath;
}

async function codeOf(run: () => unknown): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof ConnectorError ? error.code : `unexpected:${String(error)}`;
  }
  return 'no-error';
}

describe('resolveConnectorTarget', () => {
  it('resolves endpoint, capability, service secret, and a seeded redactor', () => {
    const target = resolveConnectorTarget(
      {
        FIXTURE_ENDPOINT: 'http://127.0.0.1:9310',
        FIXTURE_CAPABILITY_FILE: writeSecret('cap.token', 'payload.signature\n'),
        FIXTURE_SERVICE_SECRET_FILE: writeSecret('bearer.txt', 'super-secret-bearer\n'),
      },
      DESCRIPTOR,
    );

    expect(target.endpoint.toString()).toBe('http://127.0.0.1:9310/');
    expect(target.audience).toBe('fixture');
    expect(target.capability).toBe('payload.signature');
    expect(target.serviceSecret).toBe('super-secret-bearer');
    expect(target.redact('token payload.signature and super-secret-bearer'))
      .toBe('token [redacted] and [redacted]');
  });

  it('omits the service secret when the descriptor does not declare one', () => {
    const { serviceSecretFileEnvVar: _unused, ...readOnlyDescriptor } = DESCRIPTOR;
    const target = resolveConnectorTarget(
      {
        FIXTURE_ENDPOINT: 'http://127.0.0.1:9310',
        FIXTURE_CAPABILITY_FILE: writeSecret('cap.token', 'payload.signature'),
        FIXTURE_SERVICE_SECRET_FILE: writeSecret('bearer.txt', 'super-secret-bearer'),
      },
      readOnlyDescriptor,
    );
    expect(target.serviceSecret).toBeUndefined();
  });

  it('fails closed on a missing endpoint, capability variable, or secret variable', async () => {
    const capabilityFile = writeSecret('cap.token', 'payload.signature');
    expect(
      await codeOf(() =>
        resolveConnectorTarget({ FIXTURE_CAPABILITY_FILE: capabilityFile }, DESCRIPTOR),
      ),
    ).toBe('ENDPOINT_MISSING');
    expect(
      await codeOf(() =>
        resolveConnectorTarget({ FIXTURE_ENDPOINT: 'http://127.0.0.1:9310' }, DESCRIPTOR),
      ),
    ).toBe('CREDENTIAL_MISSING');
    expect(
      await codeOf(() =>
        resolveConnectorTarget(
          { FIXTURE_ENDPOINT: 'http://127.0.0.1:9310', FIXTURE_CAPABILITY_FILE: capabilityFile },
          DESCRIPTOR,
        ),
      ),
    ).toBe('CREDENTIAL_MISSING');
  });

  it('refuses a descriptor with no audience', async () => {
    expect(
      await codeOf(() =>
        resolveConnectorTarget(
          { FIXTURE_ENDPOINT: 'http://127.0.0.1:9310', FIXTURE_CAPABILITY_FILE: writeSecret('c.token', 'v.v') },
          { ...DESCRIPTOR, audience: '  ' },
        ),
      ),
    ).toBe('AUDIENCE_MISSING');
  });

  it('applies containment to the leased capability file', async () => {
    const contained = path.join(root, 'runtime');
    mkdirSync(contained, { mode: 0o700 });
    expect(
      await codeOf(() =>
        resolveConnectorTarget(
          {
            FIXTURE_ENDPOINT: 'http://127.0.0.1:9310',
            FIXTURE_CAPABILITY_FILE: writeSecret('outside.token', 'payload.signature'),
            FIXTURE_SERVICE_SECRET_FILE: writeSecret('bearer.txt', 'super-secret-bearer'),
          },
          DESCRIPTOR,
          { containedIn: contained },
        ),
      ),
    ).toBe('CREDENTIAL_UNSAFE');
  });
});

describe('connector package surface', () => {
  it('names no product, tool, database, or MCP framework', () => {
    const sourceDir = path.join(import.meta.dirname, '..', 'src');
    // Word-bounded on purpose: "search" legitimately contains "arc".
    const forbidden = [
      /\bmetaclaw\b/,
      /\barc\b/,
      /\bworker\b/,
      /\bresearchclaw\b/,
      /\bopenclaw\b/,
      /better-sqlite3/,
      /@modelcontextprotocol/,
      /\bskills_list\b/,
      /\bregisterTool\b/,
    ];
    for (const file of readdirSync(sourceDir)) {
      if (!file.endsWith('.ts')) continue;
      const text = readFileSync(path.join(sourceDir, file), 'utf8').toLowerCase();
      for (const term of forbidden) {
        expect(term.test(text), `${file} must not mention ${term}`).toBe(false);
      }
    }
  });
});
