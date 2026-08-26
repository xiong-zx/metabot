# ARC MCP

`@xvirobotics/arc-mcp` is an independently installed ARC product. It owns its
loopback service, product bearer, allowed project roots, durable SQLite run
state, detached official supervisor, HITL gates, recovery, and stdio MCP
client. It does not require a MetaBot repository, Bridge, process, key, Bot
name, chat ID, role, capability, or audience.

Every MCP client registers the same command:

```text
arc-mcp
```

The command is a thin stdio client for the operator-started `arc-mcp-service`.
Codex CLI/Desktop, Claude CLI/Desktop, and MetaBot therefore see the same eight
tools, schemas, and result contracts:

- `arc_run_start`
- `arc_run_get`
- `arc_run_list`
- `arc_run_pause`
- `arc_run_resume`
- `arc_run_cancel`
- `arc_hitl_submit`
- `arc_run_manifest`

## Install and configure

Install the published package and create a private product configuration:

```bash
npm install --global @xvirobotics/arc-mcp
chmod 600 "$HOME/.config/arc-mcp/config.json"
chmod 600 "$HOME/.config/arc-mcp/bearer"
arc-mcp-doctor
```

The bearer should be generated through the operator's secret-management
channel. Never put it in an MCP client configuration. The config file points to
the protected bearer file:

```json
{
  "version": 1,
  "service_url": "http://127.0.0.1:9411/mcp",
  "bearer_file": "/absolute/private/arc-mcp/bearer",
  "data_dir": "/absolute/private/arc-mcp/state",
  "allowed_project_roots": ["/absolute/project/root"],
  "fixed_project_id": "optional-project-id",
  "release_root": "/absolute/sealed/autoresearchclaw"
}
```

Set `ARC_MCP_CONFIG_FILE` only when using a non-default absolute config path.
Both the config and bearer must be regular, non-symlink files owned by the
current user with no group/other permissions. `service_url` must be dedicated
loopback HTTP with an explicit port. `allowed_project_roots` is mandatory,
canonicalized, and matched exactly; filesystem roots and ancestor widening are
rejected.

Use `runner_module` instead of `release_root` only for a pinned fixture or an
operator-controlled experiment. The two fields are mutually exclusive. There
is no silent fallback when a sealed release fails verification.

## Service ownership

Start the product service explicitly:

```bash
arc-mcp-service
```

The MCP client never starts, restarts, or owns this service. The service is the
single SQLite writer and the only owner of recovery. Multiple stdio clients
connect to that same service and observe the same durable run records. A second
service opening the same data directory is refused by the exclusive owner lock.
A verifiably dead local owner is archived before recovery; a remote or
unverifiable owner is never removed automatically.

The detached official supervisor outlives any one MCP client. It owns atomic
on-disk state, process-group pause/resume/cancel, one terminal artifact, HITL
request/response bridging, and restart reattachment. A client cannot expand
the configured project scope or select an unsealed release through a tool
argument.

## Release and integrity controls

`arc-mcp-release` installs and verifies append-only sealed releases.
`arc-mcp-supervisor` owns one detached official run. A sealed release records
the exact source revision, source-tree hash, dependency freeze, virtualenv
census, compatibility probe, and external command pins. Source and virtualenv
are recursively read-only; every launch re-verifies them. Bounded runs require
a sealed release and an explicit budget policy.

Release installation and service startup are operator actions. MCP tools never
install, select, activate, or mutate a release.

The explicit `mclaw014-candidate` release pin is an `official=false` candidate
that combines the hard budget guard with the reviewed ARC-to-MetaClaw session
contract. Its append-only manifest records a `MCLAW-014` assurance tied to the
exact commit, source tree, and patch-series digest. It is not the direct CLI
release, does not become the production `current` selector, and is installed
only from the named local patch source.

## Contracts and artifacts

- input: `autoresearchclaw.input.v1`
- output: `autoresearchclaw.output.v2`
- durable run: `autoresearchclaw.run.v1`

The authoritative output lives at
`.metabot-arc/runs/<run-id>/output.json` under the canonical allowed project
root. ARC validates the complete nested result before marking a run terminal.
Local artifact paths must remain inside that root, traversal and symlinks are
rejected, entity IDs are unique, and cross-references must resolve.

`arc_hitl_submit` records exactly one human decision for one official gate;
duplicates conflict instead of overwriting. `arc_run_manifest` reports verified
execution provenance and pending gates. It reports unproven execution and
`not_extracted` semantics explicitly rather than inventing evidence.

## Client examples

Codex:

```bash
codex mcp add arc -- arc-mcp
```

Claude Code:

```bash
claude mcp add arc -- arc-mcp
```

MetaBot uses the same command in a per-Bot external MCP descriptor. It does not
receive the bearer or any product private key.
