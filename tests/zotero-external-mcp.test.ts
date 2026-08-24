import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { ExternalMcpServerDescriptor } from '../src/mcp/external-server.js';

describe('Zotero external MCP product descriptor', () => {
  const descriptor = JSON.parse(
    readFileSync(new URL('../config/mcp-products/zotero-mcp.json', import.meta.url), 'utf8'),
  ) as ExternalMcpServerDescriptor;

  it('uses the upstream installed command with product-owned local configuration', () => {
    expect(descriptor).toEqual({
      name: 'zotero',
      enabled: true,
      command: 'zotero-mcp',
      args: [],
      env: { ZOTERO_LOCAL: 'true' },
      approvalMode: 'writes',
    });
  });

  it('contains no repository path, wrapper, credential, or MetaBot identity', () => {
    const serialized = JSON.stringify(descriptor);
    expect(serialized).not.toMatch(/packages\/|node_modules|api.?key|token|secret|botName|chatId|capability/i);
    expect(descriptor).not.toHaveProperty('enabledTools');
    expect(descriptor).not.toHaveProperty('disabledTools');
  });
});
