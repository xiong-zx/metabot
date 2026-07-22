import process from 'node:process';
import { runMemoryCoreMergeHygieneCli } from '../src/release-gates/memory-core-merge-hygiene.js';

try {
  process.exitCode = runMemoryCoreMergeHygieneCli(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
