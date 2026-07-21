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

  it('keeps Research Memory Core separate from MetaMemory', () => {
    const prompt = buildPmSystemPrompt();

    expect(prompt).toContain('Research Memory 与 MetaMemory 边界');
    expect(prompt).toContain('MetaMemory 只保存**人类可读**的 Markdown');
    expect(prompt).toContain('必须走 Research Memory Core');
    expect(prompt).toContain('不要用 `mm create` / MetaMemory 代替');
    expect(prompt).toContain('项目 root 必须遵守 Research Memory Core 的 root allowlist');
    expect(prompt).toContain('绝不能创建 `/etc` 等 MetaMemory 文件夹来模拟项目路径');
    expect(prompt).toContain('AutoResearchClaw preflight 与长任务状态');
    expect(prompt).toContain('context pack 生成、worker dispatch、output contract、ingest review');
    expect(prompt).toContain('后续状态更新不能只说 still running');
  });
});
