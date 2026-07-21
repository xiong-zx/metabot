import { describe, expect, it } from 'vitest';

import { buildPmSystemPrompt } from '../src/engines/pm-prompt.js';

describe('buildPmSystemPrompt', () => {
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
