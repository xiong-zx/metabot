import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const inputs = new Map();
const states = new Map();
const handles = new Map();

export function createArcRunner() {
  return {
    async start(input) {
      const existing = handles.get(input.run_id);
      if (existing) return existing;
      const handle = { id: `stdio-${input.run_id}` };
      handles.set(input.run_id, handle);
      inputs.set(handle.id, input);
      states.set(handle.id, 'running');
      return handle;
    },
    async pause(handle) {
      const current = states.get(handle.id);
      if (current === 'finished' || current === 'cancelled') return { state: current };
      states.set(handle.id, 'paused');
      return { state: 'paused' };
    },
    async resume(handle) {
      const current = states.get(handle.id);
      if (current === 'finished' || current === 'cancelled') return { state: current };
      states.set(handle.id, 'running');
      return { state: 'running' };
    },
    async cancel(handle) {
      const current = states.get(handle.id);
      if (current === 'finished' || current === 'cancelled') return { state: current };
      states.set(handle.id, 'cancelled');
      return { state: 'cancelled' };
    },
    async collect(handle) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      while (states.get(handle.id) === 'paused') {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (states.get(handle.id) === 'cancelled') return { state: 'cancelled' };
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
      states.set(handle.id, 'finished');
      return { state: 'finished' };
    },
  };
}
