#!/usr/bin/env python3
"""Thin JSON bridge to the official AutoResearchClaw Python interfaces."""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path


def _probe() -> dict[str, object]:
    import researchclaw
    from researchclaw.pipeline.stages import STAGE_SEQUENCE

    return {
        "success": True,
        "version": researchclaw.__version__,
        "stage_count": len(STAGE_SEQUENCE),
        "package_path": str(Path(researchclaw.__file__).resolve()),
    }


async def _hitl(payload: dict[str, object]) -> dict[str, object]:
    from researchclaw.hitl.adapters.mcp_adapter import MCPHITLAdapter

    artifacts_dir = Path(str(payload["artifacts_dir"])).resolve()
    tool = str(payload["tool"])
    arguments = payload.get("arguments")
    if not isinstance(arguments, dict):
        raise ValueError("arguments must be an object")
    adapter = MCPHITLAdapter(artifacts_dir)
    return await adapter.handle_tool_call(tool, arguments)


def main() -> int:
    payload = json.load(sys.stdin)
    action = payload.get("action")
    if action == "probe":
        result = _probe()
    elif action == "hitl":
        result = asyncio.run(_hitl(payload))
    else:
        raise ValueError(f"unknown bridge action: {action!r}")
    json.dump(result, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # fail closed without leaking environment values
        json.dump({"success": False, "error": str(exc)}, sys.stdout)
        sys.stdout.write("\n")
        raise SystemExit(1)
