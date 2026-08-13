# Official AutoResearchClaw adapter

This package is a thin, downstream-only process adapter. It does not implement
research stages. It launches the pinned official
[`aiming-lab/AutoResearchClaw`](https://github.com/aiming-lab/AutoResearchClaw)
pipeline and delegates the five HITL MCP operations to the official
`MCPHITLAdapter`.

The detached launcher also applies four fail-closed compatibility shims for
the audited `0.5.0` revision: file-backed HITL input, correction of the Stage 4
`os` scope defect, reuse of one ACP client/session across all stages, and a
post-review smoke test for Stage 10 generated code. The official checkout
remains unmodified, and `doctor` verifies the expected official function shapes
before the runtime is considered ready.

The MetaBot ARC daemon remains the outer control plane for signed local access,
trusted project roots, idempotency, durable run records, recovery, cancellation,
and terminal notifications. Official pipeline artifacts remain inside the
authorized project under `.metabot-arc/official-runs/<run-id>/`.

## Install

Use Node 22 and Python 3.11 or newer:

```bash
npm run build -w @xvirobotics/arc-researchclaw-adapter
node packages/arc-researchclaw-adapter/dist/install-cli.js install --python python3.11
```

The installer checks out the audited official revision into
`~/.metabot/arc-official/source`, creates an isolated virtualenv, installs the
official package with its optional dependencies, and verifies all 23 stages.
It also checks the keyless ACP path (`acpx` plus the configured agent, Codex by
default).

The generated runtime config uses the official ACP backend with Codex, sandbox
experiments, official HITL gates, repair/refinement, review, and paper stages.
A project-owned config can instead be selected per run with
`parameters.config_path`.

Supported start parameters are:

- `config_path`
- `hitl_mode`
- `profile`
- `from_stage` / `to_stage`
- `auto_approve`
- `skip_preflight`
- `skip_noncritical_stage`
- `no_graceful_degradation`
- `incremental_experiment`

The MCP surface combines `arc_run_start/get/list/pause/resume/cancel` with the
official `hitl_get_status`, `hitl_approve_stage`, `hitl_reject_stage`,
`hitl_inject_guidance`, and `hitl_view_output` tools.
