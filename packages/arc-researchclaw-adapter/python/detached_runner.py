#!/usr/bin/env python3
"""Launch official ResearchClaw with its file-based HITL transport.

The official CLI installs its terminal adapter unconditionally when HITL is
enabled.  A detached process has no terminal, so ``input()`` receives EOF and
the official pipeline interprets that as an abort.  ResearchClaw already ships
the file polling transport used by its MCP adapter; this wrapper selects that
official transport without modifying or copying any pipeline stages.
"""

from __future__ import annotations

import sys

from official_compat import apply_official_compatibility


def _collect_file_response(adapter: object, waiting: object) -> object:
    from researchclaw.hitl.file_wait import poll_for_response

    run_dir = getattr(adapter, "run_dir", None)
    if run_dir is None:
        raise RuntimeError("detached HITL requires a run directory")
    return poll_for_response(run_dir / "hitl")


def main() -> int:
    apply_official_compatibility()
    from researchclaw.cli import main as researchclaw_main
    from researchclaw.hitl.adapters.cli_adapter import CLIAdapter

    # The CLI creates CLIAdapter after argument parsing.  Replacing its input
    # method here keeps the official session, store, waiting/response schema,
    # rollback logic, and MCP adapter authoritative while avoiding stdin.
    CLIAdapter.collect_input = _collect_file_response  # type: ignore[method-assign]
    return researchclaw_main(sys.argv[1:])


if __name__ == "__main__":
    raise SystemExit(main())
