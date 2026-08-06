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
version, runs the downstream boundary gate, tests, and build, then opens a PR.
It never commits directly to `main` and never resolves conflicts automatically.

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
command used by the recurring upstream-sync workflow.

The repository Actions settings must allow workflows to create pull requests.
If that permission is disabled, the validated sync branch is still pushed and
a maintainer opens the PR manually.

## Release check

Before release, confirm that the merge commit retains `upstream/main` as an
ancestor, the boundary manifest passes, all `required` roots exist, forbidden
legacy paths are absent, external user rules were not overwritten, and live
tests passed from the disposable `dev` runtime.
