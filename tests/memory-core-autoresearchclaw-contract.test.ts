import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AUTORESEARCHCLAW_MEMORY_EVENT_CANDIDATE_EXAMPLE,
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

function docCandidateExample(filePath: string): unknown {
  const markdown = readFileSync(filePath, 'utf8');
  const match = /```json\n([\s\S]*?)\n```/.exec(markdown);
  if (!match) throw new Error(`No JSON example found in ${filePath}`);
  return JSON.parse(match[1]);
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
    expect(prompt).toContain('Required fields: type, summary');
    expect(prompt).toContain(
      'Optional fields: body, outcome, confidence, evidence_event_ids, subject, status, metadata',
    );
    expect(prompt).toContain('"outcome": "worked"');
    expect(prompt).toContain('"evidence_event_ids"');
    expect(prompt).toContain('"subject"');
    expect(prompt).toContain('"file_paths"');
    expect(prompt).toContain('"source_uris"');
    expect(prompt).not.toContain('"candidate_type"');
    expect(prompt).not.toContain('"evidence_ids"');
    expect(prompt).not.toContain('"evidence_paths"');
  });

  it('keeps EN/ZH docs aligned with the canonical memory event candidate example', () => {
    expect(docCandidateExample('docs/features/auto-research.md')).toEqual(
      AUTORESEARCHCLAW_MEMORY_EVENT_CANDIDATE_EXAMPLE,
    );
    expect(docCandidateExample('docs/features/auto-research.zh.md')).toEqual(
      AUTORESEARCHCLAW_MEMORY_EVENT_CANDIDATE_EXAMPLE,
    );
  });

  it('normalizes known legacy candidate aliases and preserves evidence links for ingest audit', () => {
    const deprecationTelemetry: unknown[] = [];
    const output = validateAutoResearchClawOutput(
      baseOutput({
        memory_event_candidates: [
          {
            candidate_type: 'finding',
            summary: 'Legacy candidate aliases keep evidence links',
            evidence_ids: ['mem_evt_prior'],
            evidence_paths: ['results/run.json', 'https://example.test/report'],
            metadata: {
              source: 'legacy-worker',
              autoresearchclaw_deprecated_aliases: [{ alias: 'fake', canonical: 'fake' }],
              autoresearchclaw_legacy_alias_values: { fake: ['forged'] },
            },
          },
        ],
      }),
      {
        onLegacyAliasDeprecation: (event) => deprecationTelemetry.push(event),
      },
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
    expect(candidate.metadata).not.toMatchObject({
      autoresearchclaw_deprecated_aliases: [{ alias: 'fake', canonical: 'fake' }],
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
    expect(deprecationTelemetry).toEqual([
      {
        project_id: 'proj-alpha',
        run_id: 'run-alpha',
        candidate_index: 0,
        aliases: [
          { alias: 'candidate_type', canonical: 'type' },
          { alias: 'evidence_ids', canonical: 'evidence_event_ids' },
          { alias: 'evidence_paths', canonical: 'subject.file_paths/source_uris' },
        ],
        alias_names: ['candidate_type', 'evidence_ids', 'evidence_paths'],
      },
    ]);

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

  it('pins requested candidate status to candidate while preserving requested_status metadata', () => {
    const output = validateAutoResearchClawOutput(
      baseOutput({
        memory_event_candidates: [
          {
            type: 'finding',
            summary: 'Worker requests live status',
            status: 'live',
          },
        ],
      }),
    );

    const events = autoResearchClawOutputToMemoryEvents(output, {
      actor: { kind: 'worker', id: 'worker-alpha' },
      scope: { project_id: 'proj-alpha', run_id: 'run-alpha', visibility: 'project' },
      workerEventId: 'mem_evt_worker_completed',
    });
    const candidate = events.find((item) => item.summary === 'Worker requests live status')!;
    expect(candidate.status).toBe('candidate');
    expect(candidate.metadata).toMatchObject({ requested_status: 'live' });
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

  it('rejects canonical and legacy local evidence paths outside the project root', () => {
    const projectRoot = '/tmp/metabot-memory-root';
    const cases: Array<{ name: string; candidate: Record<string, unknown>; message: RegExp }> = [
      {
        name: 'absolute subject.file_paths',
        candidate: {
          type: 'finding',
          summary: 'Absolute path should fail',
          subject: { file_paths: ['/etc/passwd'] },
        },
        message: /memory_event_candidates\[0\]\.subject\.file_paths\[0\] escapes project root: \/etc\/passwd/,
      },
      {
        name: 'parent-relative subject.file_paths',
        candidate: {
          type: 'finding',
          summary: 'Parent path should fail',
          subject: { file_paths: ['../outside.txt'] },
        },
        message: /memory_event_candidates\[0\]\.subject\.file_paths\[0\] escapes project root: \.\.\/outside\.txt/,
      },
      {
        name: 'out-of-root subject.source_uris file URI',
        candidate: {
          type: 'finding',
          summary: 'File URI should fail',
          subject: { source_uris: ['file:///etc/passwd'] },
        },
        message: /memory_event_candidates\[0\]\.subject\.source_uris\[0\] escapes project root: file:\/\/\/etc\/passwd/,
      },
      {
        name: 'legacy evidence_paths parent path',
        candidate: {
          candidate_type: 'finding',
          summary: 'Legacy parent path should fail',
          evidence_paths: ['../outside.txt'],
        },
        message: /memory_event_candidates\[0\]\.subject\.file_paths\[0\] escapes project root: \.\.\/outside\.txt/,
      },
      {
        name: 'legacy evidence_paths file URI',
        candidate: {
          candidate_type: 'finding',
          summary: 'Legacy file URI should fail',
          evidence_paths: ['file:///etc/passwd'],
        },
        message: /memory_event_candidates\[0\]\.subject\.source_uris\[0\] escapes project root: file:\/\/\/etc\/passwd/,
      },
    ];

    for (const item of cases) {
      expect(() =>
        validateAutoResearchClawOutput(
          baseOutput({
            memory_event_candidates: [item.candidate],
          }),
          { projectRoot },
        ),
      ).toThrow(item.message);
    }
  });

  it('allows external source URIs while enforcing local evidence containment', () => {
    expect(() =>
      validateAutoResearchClawOutput(
        baseOutput({
          findings: [{ summary: 'External URI is evidence', source_uris: ['https://example.test/paper'] }],
          memory_event_candidates: [
            {
              type: 'finding',
              summary: 'External candidate URI is evidence',
              subject: { source_uris: ['https://example.test/report'] },
            },
          ],
        }),
        { projectRoot: '/tmp/metabot-memory-root' },
      ),
    ).not.toThrow();
  });
});
