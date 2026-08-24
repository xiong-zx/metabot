#!/usr/bin/env node
import { loadArcProductConfig, readArcProductBearer } from './product-config.js';

try {
  const config = loadArcProductConfig();
  readArcProductBearer(config);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    config_file: config.config_file,
    service_url: config.service_url,
    allowed_project_roots: config.allowed_project_roots.length,
    runner: config.release_root ? 'release' : 'module',
  })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
}
