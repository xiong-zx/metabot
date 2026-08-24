#!/usr/bin/env node
// Emits nothing parsable, so the driver must refuse rather than assume success.
process.stdout.write('not json at all');
process.exit(1);
