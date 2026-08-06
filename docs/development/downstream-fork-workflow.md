# Downstream fork workflow

## Status

| Field                     | Value                              |
| ------------------------- | ---------------------------------- |
| Status                    | Active                             |
| Owner                     | Downstream maintainers             |
| Upstream                  | `xvirobotics/metabot:main`         |
| Downstream release branch | `origin/main`                      |
| Integration rule          | Merge upstream through a review PR |

This repository keeps upstream history intact and adds a small, explicit set
of downstream features. It does not replay the historical fork commit by
commit. The accepted feature list and dependency boundaries are machine
readable in `config/downstream-features.json`.

## Regular sync

The `Prepare upstream sync` workflow runs weekly and can also be started
manually. It fetches `upstream/main`, creates a branch named for the upstream
commit, performs a normal merge, installs dependencies under the required Node
version, runs the migration-mode downstream boundary gate, tests, and build,
then opens a PR. It never commits directly to `main` and never resolves
conflicts automatically. Manual dispatches run only from `main`.

Merged upstream code is untrusted until those checks pass. The validation job
therefore has read-only repository and pull-request permissions, and checkout
does not persist credentials. It hands a validated Git bundle to a separate,
minimal publish job. That job can push and open the PR, but it does not install
dependencies or execute code from the merged tree.

The branch name is deterministic for each upstream commit. If that branch or
an open PR already exists, automation leaves it unchanged so human conflict
fixes and review updates cannot be overwritten. To retry a closed sync PR from
scratch, a maintainer must first remove or rename its stale remote branch.

When the merge conflicts, download the conflict artifact, create a normal
`sync/upstream-*` branch locally, resolve the conflict in favor of upstream
behavior unless an accepted feature requires otherwise, and run the same
gates. A conflict in a core hook is a signal to reduce that hook, not a reason
to copy the upstream file wholesale.

## Adding or removing a downstream feature

1. Start a focused `feat/*` or `fix/*` branch from `main`.
2. Add or update one entry in `config/downstream-features.json`.
3. Keep new state machines in independent packages. Use narrow hooks when an
   upstream runtime integration is unavoidable.
4. Run `npm run check:downstream-boundaries`, focused tests, and the full CI
   gates.
5. Merge through a PR. After removing a feature, remove its manifest entry and
   verify no forbidden path or import remains.

`planned` means the migration is not yet enforcing that path. Before the
upstream-first migration is released, every retained module must be changed to
`required`; leaving a retained module as `planned` is a release failure.
`npm run check:downstream-boundaries:release` enforces this rule and is the
command used by the actual release workflow. Recurring upstream sync uses
`npm run check:downstream-boundaries`, so planned modules do not block review
PRs while the migration is still in progress.

Import boundaries use two string forms. A scoped name such as
`@xvirobotics/arc-mcp`, or an unscoped name without `/`, is a bare package
boundary and matches that package plus its subpaths. Other entries such as
`src/memory-core` are repository-relative paths; the scanner resolves relative
imports from the importing file and compares path segments, including
TypeScript `import = require(...)`. It deliberately does not interpret
TypeScript `paths` mappings, package `imports` aliases, or other custom module
resolvers. Keep boundary-sensitive imports relative or add a separate lint rule
when aliases are introduced. `reverseBoundaries` applies the same package check
from upstream-owned roots back toward downstream packages.

The repository Actions settings must allow workflows to create pull requests.
If that permission is disabled, the publish job fails without changing
`main`; a maintainer can download the validated candidate artifact during its
one-day retention window and publish a review branch manually.

## Release check

Before release, confirm that the merge commit retains `upstream/main` as an
ancestor, the boundary manifest passes, all `required` roots exist, forbidden
legacy paths and dangling symlinks are absent, reverse dependency boundaries
pass, external user rules were not overwritten, and live tests passed from the
disposable `dev` runtime.
