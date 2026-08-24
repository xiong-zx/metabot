# MetaMemory

MetaMemory is the persistent knowledge layer built into Core Console. It stores
Markdown or HTML documents in a searchable folder tree and makes sharing an
explicit per-document choice.

## Where to use it

- **Web:** open `http://localhost:9200/memory` and enter the local Core token.
- **CLI:** use `metabot memory ...`; the retired `mm` binary is not supported.
- **Agents:** install or enable the MetaMemory Skill so agents can search and
  update knowledge during a run.

## Essential commands

```bash
metabot memory search "deployment guide"
metabot memory list
metabot memory get <document-id>
metabot memory path /users/me/project/guide

metabot memory create "Guide" "# Deployment" --share --tags docs,release
echo '# Updated guide' | metabot memory update <document-id>
metabot memory share <document-id> on
metabot memory mkdir project-notes --path /users/me/project-notes
metabot memory delete <document-id>
metabot memory health
```

`create` and `update` read content from standard input when the content argument
is omitted. Use `--html` only for a complete HTML document; Markdown is the
default.

## Incremental index maintenance

Document mutations produce a transactional, versioned change outbox. Create,
update, delete, folder move/rename, and recursive folder delete emit one event
per affected document. Updates may pass `--expected-version N`; stale writes
return `409 version_conflict` without changing the document or emitting an
event.

Inspection and reconciliation are admin-only:

```bash
metabot memory events --after 0 --limit 50 --prefix /cargo1
metabot memory event-stats
metabot memory index-reconcile --root /cargo1
metabot memory index-proposals memory-status-dry-run
metabot memory index-review memory-status-dry-run 123 corrected
```

Bridge automation defaults to `off`. `events` exposes the outbox without
starting a consumer. `dry-run` coalesces relevant events, excludes `/index`,
`/status`, and indexer-origin writes, and stores bounded one-row proposals plus
review telemetry without updating the status document. Transient Core request
failures pause the current batch without consuming retry budget; deterministic
failures use bounded retries and then dead-letter the event.

P5 `full` mode can change exactly one existing row in the Current Projects
table. It requires both `METABOT_MEMORY_INDEX_QUALITY_APPROVED=true` and
`METABOT_MEMORY_INDEX_AUTO_APPLY_ENABLED=true`. The second flag is the
independent kill switch. An automatic write is allowed only when the project
row is unique, the document version still matches, only `Status`,
`Current State`, or `Next Action` changes, and every new meaningful fact is
present in the bounded source event. All other proposals remain reviewable and
do not write. Successful writes use CAS, emit a `reconciler` event, and record
before/after hashes, rows, columns, a bounded source-evidence snapshot, path,
and version.
Processing state is mirrored into a durable audit table without an outbox
foreign key, so event-retention pruning cannot remove P5 review or rollback
evidence.
The default `memory-status-full` consumer initializes at the current event head
on first use, so enabling P5 cannot replay stale historical changes. Pre-seed
an explicitly named consumer only when a controlled canary intentionally needs
a selected earlier cursor.

The P5 quality contract is fail closed: at least 30 labeled cases, 10 material
cases, and 5 auto-apply cases; decision accuracy at least 95%; auto-apply
precision 100%; correction rate at most 5%; and zero critical or structural
errors. The automated adversarial suite proves the deterministic planner,
ordering, retry, recovery, and audit safeguards; it does not prove live model
semantic accuracy. Keep both full-mode gates false until a real labeled model
evaluation satisfies the contract and a controlled live canary is approved.

When closing a live PM2 dry-run window, explicitly set
`METABOT_MEMORY_INDEX_AUTOMATION=off` before the protected restart. Removing
the key from `.env` does not clear a value already inherited by PM2.

Routing uses structured document metadata:

```bash
metabot memory update DOC_ID \
  --index-role todo \
  --project-key memory \
  --index-keywords todo,memory \
  --index-summary "Canonical memory work items."

metabot memory routing-preview --root /cargo1
```

Actual rebuilds require bridge mode `routing` and
`METABOT_MEMORY_ROUTING_REBUILD_ENABLED=true` on Core. Rebuilds use CAS, emit
an `indexer` event, and keep a bounded snapshot history. In `full`, routing
rebuild remains independently gated; a disabled routing gate does not block
safe status processing.

To stop P5, set `METABOT_MEMORY_INDEX_AUTOMATION=off` (or either P5 gate to
`false`) and perform the normal protected restart. This does not undo rows
already applied. To roll one back, inspect its `memory-status-full` processing
record, restore `previous_row` with the current document version as CAS, and
keep the processing record as the audit trail.

Folder move/delete cascades escape SQL wildcard characters in paths. Event
processing rejects cursors beyond the feed head, and event pruning is refused
until at least one durable consumer checkpoint exists. Pruning removes the
bounded outbox payload but preserves processing audit records.

## Paths and sharing

Paths organize documents but do not grant access. New writes default to your
own `/users/<owner>/...` namespace. A document is cross-agent readable only
when `shared=true`:

```bash
metabot memory visibility private   # default new documents to private
metabot memory create "Private note" "..." --no-share
metabot memory share <document-id> on
```

Keep credentials, device codes, and authorization URLs out of shared memory.

## Connection

The Personal Edition CLI defaults to the local Core:

```bash
export METABOT_CORE_URL=http://localhost:9200
export METABOT_CORE_TOKEN="$(head -n 1 ~/.metabot-core/token)"
```

The token file is created with mode `0600`. Do not paste it into logs or docs.

## Optional Wiki sync

User-configured Feishu/Lark deployments can synchronize selected memory content
to a Wiki space. This is optional and is not required by Personal Edition. See
[Wiki Sync](wiki-sync.md).
