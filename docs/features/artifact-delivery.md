# Durable artifact delivery and strict mirrors

MetaBot can durably publish user-facing output before an IM upload and can
strictly mirror a remote research host's flat `deliverables/` payload to a
small local workspace. The feature is downstream-only and opt-in.

## Roles

- The configured research host is the only writer for a project's immutable
  `deliverables/` payload.
- The local workspace is a strict read-side mirror. `README.md` and the
  generated `INDEX.md` are support files and are not part of the mirrored
  payload comparison.
- `annotations/` is user-editable and syncs between the user's local devices.
  It is never overwritten by the strict mirror. An annotation becomes a
  deliverable only through an explicit publication as a new canonical
  `review-*` or `report-*` artifact.
- `exports/` is reserved for a genuinely self-contained multi-file machine
  handoff. A normal PDF, Markdown report, figure, or table is published only to
  `deliverables/`; no capsule is created merely because the file was sent.

The mirror never pulls `runs/`, `data/`, `logs/`, `checkpoints/`, `artifacts/`,
`review/`, `reports/`, or complete `exports/` trees.

## Publish before chat delivery

Configure the producing bot with exact authenticated chat bindings:

```json
{
  "artifactDelivery": {
    "mode": "enforce",
    "projects": [
      {
        "projectId": "project-alpha",
        "root": "/srv/workspaces/projects/project-alpha",
        "chatIds": ["oc_project_alpha_primary"]
      }
    ]
  }
}
```

For a bound chat, the Bridge requires a canonical artifact filename, copies
the exact regular-file bytes atomically to `<root>/deliverables/`, verifies
SHA-256, and uploads from that durable path. An existing identical file is
reused. The same canonical name with different bytes fails before delivery and
requires a new `vNN`. Successful archival is silent; archival failures remain
user-visible so the retained temporary file can be retried. Unbound chats and
`mode: off` retain the normal output path.

## Strict mirror CLI

Start from [`config/artifact-mirror.example.json`](../../config/artifact-mirror.example.json).
The config contains host aliases and paths only; credentials remain in the
user-owned SSH configuration.

```bash
metabot artifacts status --config /absolute/path/artifact-mirror.json
metabot artifacts sync --config /absolute/path/artifact-mirror.json --apply
metabot artifacts publish --config /absolute/path/artifact-mirror.json \
  --project project-alpha --file /absolute/path/annotations/marked.pdf \
  --name project-alpha_review-tech_topic-annotations_lang-en_20260821_v01.pdf --apply
```

`status` stages and hashes the remote flat payload without changing the
workspace. `sync --apply`:

1. fetches only the remote `deliverables/` payload through the configured SSH
   alias;
2. rejects symlinks, subdirectories, empty files, and in-place mutation of a
   previously synchronized authoritative version;
3. snapshots the old local payload and catalog outside Workspaces;
4. saves local drift under `annotations/recovered/<run-id>/`;
5. adds, replaces, and deletes local payload bytes until the manifest matches;
6. creates missing artifact records, updates removed records as unavailable,
   regenerates `INDEX.md`, verifies hashes, and validates the catalog;
7. records the accepted source manifest only after every check passes.

Any failure restores the pre-run payload and catalog. A repeated successful run
is idempotent. Ordinary content changes use a new canonical version; strict
replacement repairs a local mirror and is not permission to mutate an existing
authoritative version in place.

## Deployment and rollback

Keep the mirror config, state, and rollback bytes outside the synchronized
workspace. Run `status` before the first apply. Reconcile the complete initial
union on the authoritative host before enabling deletion propagation.

Disable automatic execution to stop synchronization. Existing source,
mirrored, annotation, catalog, and rollback bytes remain in place. To restore a
specific run, copy its `deliverables-before/` and `catalog-before/` snapshot
back while the scheduler is disabled, then run `status` before re-enabling it.
No service or live database replacement is part of the mirror transaction.
