import { describe, expect, it } from 'vitest';

import { buildPmSystemPrompt } from '../src/engines/pm-prompt.js';

describe('buildPmSystemPrompt', () => {
  it('requires PM authority for worker MCP tools and uses one-hour auto reminders', () => {
    const prompt = buildPmSystemPrompt();

    expect(prompt).toContain('actor_role: "pm"');
    expect(prompt).toContain('manager/Agent/Worker 不能直接调用这些工具');
    expect(prompt).toContain('1 小时提醒');
    expect(prompt).not.toContain('40 分钟提醒');
  });
});
