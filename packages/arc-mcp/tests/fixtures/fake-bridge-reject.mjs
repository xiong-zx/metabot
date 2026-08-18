#!/usr/bin/env node
// Ignores stdin and reports an unknown action, like the real fail-closed path.
process.stdout.write(JSON.stringify({ success: false, error: "unknown bridge action: 'nope'" }));
process.exit(1);
