import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AUTORESEARCHCLAW_OUTPUT_CONTRACT_VERSION,
  MemoryEventLedger,
  ResearchLoopRunner,
  ResearchRunStore,
  type AutoResearchClawOutput,
  type AutoResearchClawWorkerAdapter,
  type ResearchWorkerHandle,
} from '../src/memory-core/index.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-research-run-store-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function output(): AutoResearchClawOutput {
  return {
    contract_version: AUTORESEARCHCLAW_OUTPUT_CONTRACT_VERSION,
    project_id: 'proj-alpha',
    run_id: 'run-alpha',
    status: 'completed',
    summary: 'Run completed with artifact index',
    hypotheses: [],
    experiments: [],
    findings: [{ id: 'finding-1', summary: 'Run store captured lifecycle' }],
    negative_results: [],
    decisions: [],
    artifacts: [{ id: 'artifact-results', uri: 'file://results.json', summary: 'Results JSON' }],
    open_questions: [],
    memory_event_candidates: [],
    recommended_followups: [],
    tool_trace: [],
  };
}

describe('ResearchRunStore', () => {
  it('persists run lifecycle records and artifact index entries', () => {
    const store = new ResearchRunStore(dir);

    store.startRun({
      id: 'run-alpha',
      projectId: 'proj-alpha',
      projectRoot: dir,
      task: 'Build memory lifecycle',
      domain: 'metabot',
      now: new Date('2026-07-06T00:00:00Z'),
    });
    store.updateRun('run-alpha', {
      status: 'worker_dispatched',
      workerId: 'worker-alpha',
      artifactUri: 'file://autoresearchclaw-output.json',
      now: new Date('2026-07-06T00:01:00Z'),
    });
    store.indexArtifact({
      id: 'artifact-results',
      runId: 'run-alpha',
      projectId: 'proj-alpha',
      uri: 'file://results.json',
      summary: 'Results JSON',
      now: new Date('2026-07-06T00:02:00Z'),
    });

    const reloaded = new ResearchRunStore(dir);
    expect(reloaded.getRun('run-alpha')).toMatchObject({
      id: 'run-alpha',
      status: 'worker_dispatched',
      worker_id: 'worker-alpha',
      artifact_uri: 'file://autoresearchclaw-output.json',
    });
    expect(reloaded.listArtifacts({ runId: 'run-alpha' })).toEqual([
      expect.objectContaining({
        id: 'artifact-results',
        project_id: 'proj-alpha',
        uri: 'file://results.json',
      }),
    ]);
  });
});

describe('ResearchLoopRunner + ResearchRunStore', () => {
  it('updates run lifecycle and indexes AutoResearchClaw artifacts', async () => {
    const ledger = new MemoryEventLedger(dir);
    const runStore = new ResearchRunStore(dir);
    const worker: AutoResearchClawWorkerAdapter = {
      async dispatch(): Promise<ResearchWorkerHandle> {
        return {
          workerId: 'worker-alpha',
          workerChatId: 'worker-worker-alpha',
          artifactUri: 'file://autoresearchclaw-output.json',
        };
      },
      async collectOutput() {
        return output();
      },
    };
    const runner = new ResearchLoopRunner({
      readEvents: () => ledger.readAll(),
      appendEvent: (event) => ledger.append(event),
      worker,
      runStore,
    });

    await runner.run({
      projectId: 'proj-alpha',
      runId: 'run-alpha',
      projectRoot: dir,
      task: 'Run lifecycle integration',
      domain: 'metabot',
      actor: { kind: 'agent', id: 'agent-pm' },
      now: new Date('2026-07-06T00:00:00Z'),
    });

    expect(runStore.getRun('run-alpha')).toMatchObject({
      id: 'run-alpha',
      status: 'completed',
      context_pack_id: expect.stringMatching(/^ctx_/),
      worker_id: 'worker-alpha',
      artifact_uri: 'file://autoresearchclaw-output.json',
      output_summary: 'Run completed with artifact index',
      artifact_ids: ['artifact-results'],
    });
    expect(runStore.listArtifacts({ projectId: 'proj-alpha' })).toEqual([
      expect.objectContaining({
        id: 'artifact-results',
        run_id: 'run-alpha',
        uri: 'file://results.json',
      }),
    ]);
  });

  it('marks the run failed when final memory event append fails after worker completion', async () => {
    const ledger = new MemoryEventLedger(dir);
    const runStore = new ResearchRunStore(dir);
    const worker: AutoResearchClawWorkerAdapter = {
      async dispatch(): Promise<ResearchWorkerHandle> {
        return { workerId: 'worker-alpha' };
      },
      async collectOutput() {
        return output();
      },
    };
    const runner = new ResearchLoopRunner({
      readEvents: () => ledger.readAll(),
      appendEvent: (event) => {
        if (event.type === 'finding') {
          throw new Error('simulated append failure');
        }
        return ledger.append(event);
      },
      worker,
      runStore,
    });

    const result = await runner.run({
      projectId: 'proj-alpha',
      runId: 'run-alpha',
      projectRoot: dir,
      task: 'Run lifecycle failure',
      actor: { kind: 'agent', id: 'agent-pm' },
    });

    expect(result.status).toBe('failed');
    expect(result.errors.some((error) => error.includes('simulated append failure'))).toBe(true);
    expect(runStore.getRun('run-alpha')).toMatchObject({
      status: 'failed',
      error_messages: [expect.stringContaining('simulated append failure')],
    });
  });
});
