#!/usr/bin/env node
// Stands in for a long official run so pause, resume, cancel, and restart
// recovery can be exercised against real process-group signals.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const output = args[args.indexOf('--output') + 1];
if (!output) throw new Error('--output is required');
mkdirSync(output, { recursive: true });
writeFileSync(path.join(output, 'metabot-child-started.json'), `${JSON.stringify({ pid: process.pid })}\n`);

process.on('SIGTERM', () => process.exit(143));
setInterval(() => {}, 1_000);
