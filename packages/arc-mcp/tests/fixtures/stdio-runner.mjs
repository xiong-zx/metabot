import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const inputs = new Map();
const states = new Map();

export function createArcRunner() {
  return {
    async start(input) {
      const handle = { id: `stdio-${input.run_id}` };
      inputs.set(handle.id, input);
      states.set(handle.id, 'running');
      return handle;
    },
    async pause(handle) {
      states.set(handle.id, 'paused');
    },
    async resume(handle) {
      states.set(handle.id, 'running');
    },
    async cancel(handle) {
      states.set(handle.id, 'cancelled');
    },
    async collect(handle) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      while (states.get(handle.id) === 'paused') {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (states.get(handle.id) === 'cancelled') return;
      const input = inputs.get(handle.id);
      const output = {
        contract_version: 'autoresearchclaw.output.v2',
        project_id: input.project_id,
        run_id: input.run_id,
        status: 'completed',
        summary: 'The stdio fake runner completed.',
        hypotheses: [],
        experiments: [],
        findings: [],
        negative_results: [],
        decisions: [],
        artifacts: [],
        open_questions: [],
        recommended_followups: [],
        tool_trace: [{ tool: 'stdio_fake_runner', summary: 'Wrote the contract artifact.', status: 'completed' }],
      };
      const target = path.join(input.project_root, input.artifact_path);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, `${JSON.stringify(output)}\n`, 'utf8');
    },
  };
}
