import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

for (const [product, command] of [['arc', 'arc-mcp'], ['metaclaw', 'metaclaw-mcp']] as const) {
  describe(`${product} independent MCP descriptor`, () => {
    const descriptor = JSON.parse(
      readFileSync(new URL(`../config/mcp-products/${product}-mcp.json`, import.meta.url), 'utf8'),
    ) as Record<string, unknown>;

    it('uses the independently installed product command', () => {
      expect(descriptor).toMatchObject({ name: product, enabled: true, command, args: [], approvalMode: 'writes' });
    });

    it('contains no MetaBot authority or repository lifecycle path', () => {
      expect(JSON.stringify(descriptor)).not.toMatch(/capability|audience|public.?key|botName|chatId|packages\/|node_modules/i);
    });
  });
}
