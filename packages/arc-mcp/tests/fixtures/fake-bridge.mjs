#!/usr/bin/env node
// Stands in for the official Python bridge: one JSON action on stdin, one JSON
// result on stdout. Mirrors the real fail-closed error shape.
import { readFileSync } from 'node:fs';

let payload = {};
try {
  payload = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.stdout.write(JSON.stringify({ success: false, error: 'Expecting value: line 1 column 1 (char 0)' }));
  process.exit(1);
}
if (payload.action !== 'probe') {
  process.stdout.write(JSON.stringify({ success: false, error: `unknown bridge action: ${payload.action}` }));
  process.exit(1);
}
process.stdout.write(
  JSON.stringify({ success: true, version: '0.5.0', stage_count: 23, package_path: process.env.FAKE_PACKAGE_PATH }),
);
