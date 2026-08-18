# Vendored provenance

This package is a mechanical in-repository copy of the standalone FIX-009
RulesPack engine at commit `1d866a994fb1ef8985b9df2f4ef3cb41f0926d81`.
It contains the deterministic compiler, renderer, validators, structured
sources, SQLite store, cache/LKG logic, transport schema, telemetry, and CLI.
The only source-byte normalization is removal of five trailing spaces in
`src/store.ts` so MetaBot's `git diff --check` gate passes.

Bounded update procedure:

1. Obtain the reviewed standalone source at an explicit commit.
2. Diff `src/`, `test/`, `docs/`, `README.md`, `LICENSE`, `package.json`, and
   `tsconfig.json` against this package.
3. Copy only reviewed engine changes; retain the MetaBot workspace package
   name and TypeScript `composite` build setting.
4. Update the commit above and record whether the compiler/schema version
   changed.
5. Run the engine's full focused tests, adapter tests, downstream-boundary
   gate, package build/typecheck/lint, and the in-process integration smoke.

Never replace this directory with a symlink or an absolute import. Runtime
code must resolve only the checked-in workspace package.
