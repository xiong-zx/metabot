# RulesPack

Standalone deterministic RulesPack engine for later thin Codex-only MetaBot
integration. It owns structured Rules, exact subject matching, deterministic
composition, safe rendering, SQLite state, cache/LKG, source interfaces,
receipts, feedback, telemetry, and operator diagnostics. It does not import or
modify MetaBot, contact MetaMemory directly, call an LLM, or deploy anything.

## Requirements and commands

- Node.js 22.13 or newer (tested with Node 22.23.2)
- npm 10 or newer

```bash
npm install
npm run typecheck
npm test
npm run build
node dist/cli.js --help
```

The package has zero runtime dependencies. TypeScript, `tsx`, and Node types
are development dependencies. SQLite uses Node 22's built-in `node:sqlite`
API; Node 22 may print its standard experimental-API warning.

## Minimal API

```ts
import {
  RulesPackEngine,
  RulesStore,
  configSource,
} from '@metabot/rulespack';

const store = new RulesStore('./rules-state.sqlite');
const engine = new RulesPackEngine({ store, mode: 'shadow' });

// Source refresh is asynchronous and outside the per-turn hot path.
const sourceState = await engine.refreshSources([
  configSource({ id: 'host-policy', revision: '42', rules }),
]);

// Per-turn compilation is deterministic local code and cache-backed.
const result = engine.compile({ subject, sourceState });
// Inject result.injectionText only when mode is enforce.
```

The complete public contract is in [docs/API.md](docs/API.md). Adapter
responsibilities, failure semantics, cache generations, migration, and rollback
are in [docs/INTEGRATION.md](docs/INTEGRATION.md).

## Operator CLI

The CLI defaults to `./rules-state.sqlite`; set `--db` or `RULESPACK_DB` to an
isolated RulesPack-owned database. Its default mode is `off`.

```bash
rulespack validate examples/rules.json
rulespack --db ./rules-state.sqlite import examples/rules.json
rulespack --db ./rules-state.sqlite --mode shadow explain \
  --subject examples/subject.json
rulespack --db ./rules-state.sqlite revoke global.concise --reason "superseded"
rulespack --db ./rules-state.sqlite status
rulespack --db ./rules-state.sqlite receipts
rulespack --db ./rules-state.sqlite feedback-add \
  --digest sha256:... --kind missing --message "Expected the project rule"
rulespack --db ./rules-state.sqlite cache-clear
```

`cache-clear` removes only recomputable pack-cache/LKG records. It does not
delete Rule history, source generations, audits, receipts, or feedback.
Raw imports cannot self-assert `platform`/`runtime` trust. The explicit
`--trusted-authority` flag is reserved for an operator importing bytes from a
compiler-owned source; never use it for project files, chat data, retrieved
documents, or curator candidates.

## Scope

This repository is the complete isolated engine foundation. It intentionally
does not contain:

- MetaBot executor or prompt hooks;
- Agent Team, Agent Bus, Worker, ARC, scheduler, or restart bindings;
- authenticated capability/signature verification or replay storage;
- a concrete MetaMemory client;
- live chat, runtime, deployment, service restart, or iMac-to-Savio changes;
- Rule Curator or any LLM-based rule extraction.

Those are adapter/integration work. The engine supplies the stable types and
verification primitives they consume.
