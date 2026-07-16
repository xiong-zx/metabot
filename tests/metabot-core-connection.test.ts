import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkMetabotCoreMemoryConnection,
  resolveMetabotCoreConnection,
} from '../src/memory/core-connection.js';

const ORIGINAL_ENV = {
  METABOT_CORE_URL: process.env.METABOT_CORE_URL,
  METABOT_CORE_TOKEN: process.env.METABOT_CORE_TOKEN,
  HTTP_PROXY: process.env.HTTP_PROXY,
  HTTPS_PROXY: process.env.HTTPS_PROXY,
  http_proxy: process.env.http_proxy,
  https_proxy: process.env.https_proxy,
  NO_PROXY: process.env.NO_PROXY,
  no_proxy: process.env.no_proxy,
};

afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('metabot-core connection resolution', () => {
  it('uses explicit overrides before env and token files', () => {
    process.env.METABOT_CORE_URL = 'https://env.example/';
    process.env.METABOT_CORE_TOKEN = 'env-token';

    const config = resolveMetabotCoreConnection({
      baseUrlOverride: 'https://override.example///',
      tokenOverride: 'override-token',
    });

    expect(config.baseUrl).toBe('https://override.example');
    expect(config.token).toBe('override-token');
    expect(config.tokenSource).toBe('override');
  });

  it('falls back to the configured token file when env token is absent', () => {
    delete process.env.METABOT_CORE_TOKEN;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-core-token-'));
    const tokenFile = path.join(dir, 'token');
    fs.writeFileSync(tokenFile, '\nfile-token\n');

    try {
      const config = resolveMetabotCoreConnection({
        env: { METABOT_CORE_URL: 'https://core.example/' } as NodeJS.ProcessEnv,
        tokenFile,
      });
      expect(config.baseUrl).toBe('https://core.example');
      expect(config.token).toBe('file-token');
      expect(config.tokenSource).toBe('file');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('checks the central MetaMemory endpoint with the resolved token', async () => {
    process.env.HTTP_PROXY = '';
    process.env.HTTPS_PROXY = '';
    process.env.http_proxy = '';
    process.env.https_proxy = '';
    process.env.NO_PROXY = '127.0.0.1,localhost';

    const server = http.createServer((req, res) => {
      expect(req.headers.authorization).toBe('Bearer test-token');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        folders: {
          id: 'root',
          name: 'root',
          path: '/',
          document_count: 1,
          children: [
            { id: 'child', name: 'child', path: '/child', document_count: 2, children: [] },
          ],
        },
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    try {
      const result = await checkMetabotCoreMemoryConnection({
        baseUrlOverride: `http://127.0.0.1:${port}`,
        tokenOverride: 'test-token',
      });
      expect(result.ok).toBe(true);
      expect(result.folderCount).toBe(1);
      expect(result.documentCount).toBe(3);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
