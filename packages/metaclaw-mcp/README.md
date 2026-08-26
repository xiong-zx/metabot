# MetaClaw MCP

`@xvirobotics/metaclaw-mcp` is an independently installed stdio MCP product for
an operator-started MetaClaw service. Codex CLI/Desktop, Claude CLI/Desktop, and
MetaBot register the same command:

```text
metaclaw-mcp
```

The product does not require MetaBot, a Bridge, a MetaBot process, a MetaBot
private or public key, a capability file, an audience, or Bot/chat/role identity.
MetaBot is only an optional client through its generic external MCP adapter.

## Five-tool contract

- `metaclaw_health`
- `metaclaw_status`
- `metaclaw_infer`
- `metaclaw_skills_list`
- `metaclaw_skill_get`

There are no lifecycle, setup, auth-mutation, memory, training, record deletion,
skill-write, arbitrary-path, model-selection, provider-selection, or endpoint-
selection tools. Every input schema is strict.

## Installation and product configuration

```bash
npm install --global @xvirobotics/mcp-connector @xvirobotics/metaclaw-mcp
metaclaw-mcp-doctor
```

The only startup variables select product-owned files:

| Variable | Purpose |
| --- | --- |
| `METACLAW_MCP_PROFILE_FILE` | Absolute path to the fixed `0600` managed profile. |
| `METACLAW_MCP_RELEASE_MANIFEST` | Absolute path to the sealed release manifest. |

The profile owns the loopback endpoint, service bearer file, exact model and
provider, managed HOME, release identity, immutable pins, request limits, shared
skills root, and durable cost-ledger policy. MCP clients never receive the
service bearer.

The service is operator-started. This MCP command probes and calls it but never
starts, stops, restarts, repairs, installs, selects, or activates it.

## Mechanical inference gates

`metaclaw_infer` forms no provider request until all of these checks succeed:

1. The managed profile is unchanged and every required pin is exact.
2. The release manifest and every sealed file, dependency freeze, permission,
   executable, and provenance field re-verify.
3. The service endpoint is loopback and fixed; request construction allowlists
   the pinned model/provider and strips caller controls.
4. The product cost ledger atomically reserves call count, worst-case input and
   output tokens, and worst-case USD before dispatch. A concurrent ledger writer
   or exhausted ceiling refuses the call. Settlement records success/failure
   and provider usage without refunding the conservative reservation.
5. Required upstream security and ARC side-turn gates carry exact evidence tied
   to the sealed release rather than free-form profile claims.

An inactive profile may bind MCLAW-014 by passing the append-only ARC candidate
manifest to `metaclaw-release profile-create --arc-manifest ...`. The profile
stores its digest and exact release/commit/tree/series identity; startup and
every network-capable call re-read the protected manifest and require its
single machine-readable MCLAW-014 assurance. A hand-written gate string is
rejected. Binding creates a new inactive profile and does not start either
product or form provider traffic. Closing MCLAW-014 also leaves MCLAW-015
mechanically open; profile text cannot authorize the bounded billable-call
acceptance.

The response must echo the pinned model and provider. Missing or mismatched
identity is a contract violation. Streaming and upstream cancellation are
reported as unsupported; a deadline never claims that provider work or cost was
cancelled.

## Release and profile tooling

`metaclaw-release` installs and verifies append-only sealed candidates, creates
an inactive isolated profile, snapshots ARC-owned skills safely, and performs
operator-only diagnostics. It does not start the service or change live
activation.

The managed profile uses an independent HOME and state root, loopback-only
endpoint, fixed `skills_only` mode, disabled auto-evolution/memory/scheduler/RL/
WeChat, disabled OpenClaw auto-configuration, hidden admin and memory routes,
bounded bodies/concurrency/deadlines, a protected service bearer, and exact
release/process identity pins.

## Client examples

```bash
codex mcp add metaclaw -- metaclaw-mcp
claude mcp add metaclaw -- metaclaw-mcp
```

MetaBot uses the same command and product variables in a per-Bot external MCP
descriptor. One missing or failed product removes only that entry.
