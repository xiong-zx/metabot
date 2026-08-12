import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('official ARC boundary', () => {
  it('contains no copied official pipeline implementation or Bridge/Worker imports', () => {
    const root = path.resolve(import.meta.dirname, '..');
    const production = ['adapter.ts', 'factory.ts', 'supervisor.ts']
      .map((file) => readFileSync(path.join(root, 'src', file), 'utf8'))
      .join('\n');
    expect(production).not.toMatch(/from ['"].*(?:src\/bridge|src\/engines|worker-runner-mcp)/);
    expect(production).not.toMatch(/class\s+(?:Pipeline|Literature|Hypothesis|PeerReview)/);
    const bridge = readFileSync(path.join(root, 'python', 'bridge.py'), 'utf8');
    expect(bridge).toContain('from researchclaw.hitl.adapters.mcp_adapter import MCPHITLAdapter');
    expect(bridge).toContain('from researchclaw.pipeline.stages import GATE_ROLLBACK, Stage');
    expect(bridge).not.toContain('def execute_pipeline');
    const detachedRunner = readFileSync(path.join(root, 'python', 'detached_runner.py'), 'utf8');
    expect(detachedRunner).toContain('from researchclaw.hitl.file_wait import poll_for_response');
    expect(detachedRunner).toContain('from researchclaw.cli import main as researchclaw_main');
    expect(detachedRunner).not.toContain('def execute_pipeline');
    const compatibility = readFileSync(path.join(root, 'python', 'official_compat.py'), 'utf8');
    expect(compatibility).toContain('inspect.getsource(function)');
    expect(compatibility).toContain('_metabot_cached_acp_factory');
    expect(compatibility).not.toContain('def execute_pipeline');
    expect(compatibility).not.toMatch(/class\s+(?:Pipeline|Literature|Hypothesis|PeerReview)/);
  });
});
