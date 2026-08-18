#!/usr/bin/env node
// Stands in for an official run that pauses at a HITL gate using the official
// file transport (researchclaw.hitl.file_wait): it writes waiting.json and
// blocks until response.json appears, then records what it consumed.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const output = args[args.indexOf('--output') + 1];
if (!output) throw new Error('--output is required');
const hitlDir = path.join(output, 'hitl');
mkdirSync(hitlDir, { recursive: true });
writeFileSync(
  path.join(hitlDir, 'waiting.json'),
  `${JSON.stringify(
    {
      stage: 5,
      stage_name: 'PROPOSAL_REVIEW',
      reason: 'gate_approval',
      since: '2026-08-15T12:00:00+00:00',
      available_actions: ['approve', 'reject', 'edit', 'skip'],
      context_summary: 'Fixture gate awaiting an operator decision.',
      output_files: ['deliverables/proposal.md'],
    },
    null,
    2,
  )}\n`,
);

const responsePath = path.join(hitlDir, 'response.json');
const deadline = Date.now() + 20_000;
const poll = setInterval(() => {
  let raw;
  try {
    raw = readFileSync(responsePath, 'utf8');
  } catch {
    if (Date.now() > deadline) {
      clearInterval(poll);
      process.exit(3);
    }
    return;
  }
  clearInterval(poll);
  rmSync(responsePath, { force: true });
  rmSync(path.join(hitlDir, 'waiting.json'), { force: true });
  writeFileSync(path.join(output, 'metabot-observed-gate.json'), raw);
  writeFileSync(
    path.join(output, 'pipeline_summary.json'),
    `${JSON.stringify({ stages_done: 23, stages_failed: 0, final_status: 'completed' }, null, 2)}\n`,
  );
  process.exit(0);
}, 25);
