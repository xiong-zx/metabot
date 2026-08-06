import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { ArcOutput } from '../src/contract.js';

export function temporaryDirectory(prefix = 'arc-mcp-'): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

export function projectDirectory(parent: string, name = 'project'): string {
  const projectRoot = path.join(parent, name);
  mkdirSync(projectRoot, { recursive: true });
  return projectRoot;
}

export function removeDirectory(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
}

export function validOutput(projectId: string, runId: string, overrides: Partial<ArcOutput> = {}): ArcOutput {
  return {
    contract_version: 'autoresearchclaw.output.v2',
    project_id: projectId,
    run_id: runId,
    status: 'completed',
    summary: 'The bounded fake research run completed.',
    hypotheses: [
      {
        id: 'hypothesis-1',
        statement: 'The proposed change improves the measured outcome.',
        rationale: 'This is a deterministic contract fixture.',
        status: 'supported',
      },
    ],
    experiments: [
      {
        id: 'experiment-1',
        hypothesis_ids: ['hypothesis-1'],
        summary: 'Compared the proposed change with the baseline.',
        method: 'Deterministic fake runner.',
        status: 'completed',
        metrics: { score: 1 },
      },
    ],
    findings: [
      {
        id: 'finding-1',
        summary: 'The fixture supports the hypothesis.',
        confidence: 0.9,
        evidence: [
          {
            id: 'evidence-1',
            uri: 'https://example.test/evidence/1',
            summary: 'External evidence URI used by the contract test.',
          },
        ],
      },
    ],
    negative_results: [
      {
        id: 'negative-1',
        experiment_id: 'experiment-1',
        summary: 'A secondary measurement did not change.',
      },
    ],
    decisions: [
      {
        id: 'decision-1',
        summary: 'Keep the proposed change for follow-up.',
        rationale: 'The primary deterministic metric improved.',
        related_finding_ids: ['finding-1'],
      },
    ],
    artifacts: [],
    open_questions: [
      {
        id: 'question-1',
        question: 'Does the result generalize to a larger sample?',
      },
    ],
    recommended_followups: ['Run a larger independent experiment.'],
    tool_trace: [
      {
        tool: 'fake_runner',
        summary: 'Produced deterministic test evidence.',
        status: 'completed',
      },
    ],
    ...overrides,
  };
}
