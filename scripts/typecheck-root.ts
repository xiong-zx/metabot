import { runTypecheckCli } from '../src/release-gates/root-typecheck.js';

process.exitCode = runTypecheckCli();
