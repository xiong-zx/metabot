import { describe, expect, it } from 'vitest';
import {
  AUTORESEARCHCLAW_OUTPUT_CONTRACT_VERSION,
  autoResearchClawOutputToMemoryEvents,
  buildAutoResearchClawPrompt,
  validateAutoResearchClawOutput,
} from '../src/memory-core/index.js';

function baseOutput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contract_version: AUTORESEARCHCLAW_OUTPUT_CONTRACT_VERSION,
    project_id: 'proj-alpha',
    run_id: 'run-alpha',
    status: 'completed',
    summary: 'Contract test output',
    hypotheses: [],
    experiments: [],
    findings: [],
    negative_results: [],
    decisions: [],
    artifacts: [],
    open_questions: [],
    memory_event_candidates: [],
    recommended_followups: [],
    tool_trace: [{ tool: 'vitest', summary: 'Validated contract', status: 'completed' }],
    ...overrides,
  };
}

describe('AutoResearchClaw output contract', () => {
  it('prompts workers with a non-empty canonical memory event candidate example', () => {
    const prompt = buildAutoResearchClawPrompt({
      project_id: 'proj-alpha',
      run_id: 'run-alpha',
      task: 'Run contract smoke test',
      project_root: '/tmp/proj-alpha',
      context_pack_markdown: '# Context',
    });

    expect(prompt).toContain('Canonical memory_event_candidates item example');
    expect(prompt).toContain('"type": "finding"');
    expect(prompt).toContain('"summary": "Context pack preserved the negative result evidence chain."');
    expect(prompt).toContain('"evidence_event_ids"');
    expect(prompt).toContain('"subject"');
    expect(prompt).toContain('"file_paths"');
    expect(prompt).toContain('"source_uris"');
    expect(prompt).not.toContain('"candidate_type"');
    expect(prompt).not.toContain('"evidence_ids"');
    expect(prompt).not.toContain('"evidence_paths"');
  });

  it('normalizes known legacy candidate aliases and preserves evidence links for ingest audit', () => {
    const output = validateAutoResearchClawOutput(
      baseOutput({
        memory_event_candidates: [
          {
            candidate_type: 'finding',
            summary: 'Legacy candidate aliases keep evidence links',
            evidence_ids: ['mem_evt_prior'],
            evidence_paths: ['results/run.json', 'https://example.test/report'],
            metadata: { source: 'legacy-worker' },
          },
        ],
      }),
    );

    const candidate = output.memory_event_candidates[0]!;
    expect(candidate).toMatchObject({
      type: 'finding',
      summary: 'Legacy candidate aliases keep evidence links',
      evidence_event_ids: ['mem_evt_prior'],
      subject: {
        file_paths: ['results/run.json'],
        source_uris: ['https://example.test/report'],
      },
    });
    expect(candidate.metadata).toMatchObject({
      source: 'legacy-worker',
      autoresearchclaw_deprecated_aliases: [
        { alias: 'candidate_type', canonical: 'type' },
        { alias: 'evidence_ids', canonical: 'evidence_event_ids' },
        { alias: 'evidence_paths', canonical: 'subject.file_paths/source_uris' },
      ],
      autoresearchclaw_legacy_alias_values: {
        candidate_type: 'finding',
        evidence_ids: ['mem_evt_prior'],
        evidence_paths: ['results/run.json', 'https://example.test/report'],
      },
    });

    const events = autoResearchClawOutputToMemoryEvents(output, {
      actor: { kind: 'agent', id: 'agent-pm' },
      scope: { project_id: 'proj-alpha', run_id: 'run-alpha', visibility: 'project' },
      workerEventId: 'mem_evt_worker_completed',
    });
    const event = events.find((item) => item.summary === 'Legacy candidate aliases keep evidence links')!;
    expect(event.evidence_event_ids).toEqual(['mem_evt_worker_completed', 'mem_evt_prior']);
    expect(event.subject).toMatchObject({
      file_paths: ['results/run.json'],
      source_uris: ['https://example.test/report'],
    });
    expect(event.metadata).toMatchObject({
      autoresearchclaw_deprecated_aliases: [
        { alias: 'candidate_type', canonical: 'type' },
        { alias: 'evidence_ids', canonical: 'evidence_event_ids' },
        { alias: 'evidence_paths', canonical: 'subject.file_paths/source_uris' },
      ],
    });
  });

  it('rejects unknown aliases and unknown strict candidate fields', () => {
    expect(() =>
      validateAutoResearchClawOutput(
        baseOutput({
          memory_event_candidates: [
            {
              type: 'finding',
              summary: 'Unknown alias should fail',
              evidence_path: ['results/run.json'],
            },
          ],
        }),
      ),
    ).toThrow(/memory_event_candidates\[0\]\.evidence_path is not allowed/);
  });

  it('rejects malformed candidate values before ingest', () => {
    expect(() =>
      validateAutoResearchClawOutput(
        baseOutput({
          memory_event_candidates: [{ type: 'not_a_memory_type', summary: 'Bad type' }],
        }),
      ),
    ).toThrow(/memory_event_candidates\[0\]\.type has unsupported value/);

    expect(() =>
      validateAutoResearchClawOutput(
        baseOutput({
          memory_event_candidates: [{ type: 'memory_superseded', summary: 'Controlled type' }],
        }),
      ),
    ).toThrow(/cannot be a controlled memory event type/);

    expect(() =>
      validateAutoResearchClawOutput(
        baseOutput({
          memory_event_candidates: [
            {
              type: 'finding',
              summary: 'Malformed subject',
              subject: { file_paths: [42] },
            },
          ],
        }),
      ),
    ).toThrow(/memory_event_candidates\[0\]\.subject\.file_paths\[0\]/);
  });
});
