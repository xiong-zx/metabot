# @xvirobotics/mcp-connector

Product-neutral primitives shared by spawned MCP connectors.

This package owns exactly four concerns:

- **endpoint** — validate that a connector target is literal-loopback HTTP with
  no embedded credentials, query, or fragment, and resolve request paths without
  letting them escape the origin;
- **protected credential files** — read a leased `0600` regular file owned by the
  current uid, with `O_NOFOLLOW`, a descriptor re-stat, optional containment
  under a runtime root, and a hard size bound;
- **redaction** — strip held secrets from anything the connector stringifies;
- **bounded transport** — one non-streaming request/response exchange with a
  whole-request deadline and request/response byte ceilings.

## What this package must never contain

It is not a gateway. It has no daemon, no database, no shared bearer, and no
universal audience. It does not know a tool name, a scope vocabulary, a profile
layout, or a release manifest. A descriptor names an endpoint variable, a
capability-file variable, an audience string, and optionally a service-secret
variable — nothing else.

The audience is **carried, not verified**. Signature verification belongs to the
server behind the endpoint; a connector that acted on an unverified claim would
be authorizing itself.

MetaBot core spawns connectors as separate processes and never imports this
package. That direction is enforced by the `upstream-runtime-isolation` reverse
boundary in `config/downstream-features.json`.

## Adoption status

`packages/metaclaw-mcp` consumes these primitives. The ARC and Worker Runner
proxies still carry their own equivalents; migrating them is deliberately
separate work so that a connector change cannot take down two shipped daemons at
once.
