#!/usr/bin/env node
// Stands in for the pinned official AutoResearchClaw CLI: it writes the same
// pipeline_summary.json and deliverables the supervisor collects, and makes no
// provider or model call.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const output = args[args.indexOf('--output') + 1];
if (!output) throw new Error('--output is required');
mkdirSync(path.join(output, 'deliverables'), { recursive: true });
writeFileSync(
  path.join(output, 'pipeline_summary.json'),
  `${JSON.stringify({ stages_done: 23, stages_failed: 0, final_status: 'completed' }, null, 2)}\n`,
);
writeFileSync(path.join(output, 'deliverables', 'report.md'), '# fake official deliverable\n');
writeFileSync(path.join(output, 'metabot-observed-argv.json'), `${JSON.stringify(args)}\n`);
process.exit(0);
