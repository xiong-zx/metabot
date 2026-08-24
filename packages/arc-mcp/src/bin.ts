#!/usr/bin/env node
import { loadArcProductConfig, readArcProductBearer } from './product-config.js';
import { runArcProductProxy } from './product-proxy.js';

const config = loadArcProductConfig();
const close = await runArcProductProxy({
  endpoint: config.service_url,
  bearer: readArcProductBearer(config),
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void close().finally(() => process.exit(0)));
}
