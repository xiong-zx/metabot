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


def _gate_rollback(payload: dict[str, object]) -> dict[str, object]:
    from researchclaw.pipeline.stages import GATE_ROLLBACK, Stage

    stage = Stage(int(payload["stage"]))
    target = GATE_ROLLBACK.get(stage)
    if target is None:
        return {
            "success": False,
            "error": f"Official ResearchClaw has no rollback target for {stage.name}",
        }
    return {
        "success": True,
        "stage": int(stage),
        "stage_name": stage.name,
        "from_stage": target.name,
    }


def _budget_policy(payload: dict[str, object]) -> dict[str, object]:
    """Return the *effective* budget-relevant config, as ARC will run it.

    The driver validates the ceiling a bounded run will actually obey, so it
    must validate the document the official process resolves rather than one a
    second YAML implementation produced.  This therefore runs inside the
    release's own interpreter and uses ``RCConfig.load``.

    Reading the raw YAML instead would be actively wrong, in two ways that
    both fail *open*.  ARC's dataclass defaults enable several billable stages
    the guard declares structurally unbudgetable — ``experiment.opencode``,
    ``experiment.repair.use_opencode`` and the Gemini image backend all
    default to true — so an absent key means "enabled", not "off".  And
    ``RCConfig.load`` lets a named ``project.profile`` fill in any key the
    file leaves unset, including the ``llm`` and ``budget`` sections, so the
    bytes on disk are not necessarily the policy the run obeys.

    Only the fields the driver checks are returned.  Base URLs, key
    environment names, prompts and every other section stay inside this
    process, so a bounded-run record can never acquire a credential.  The
    digest of the raw file is returned alongside so the caller can prove the
    document it validated is the exact file it hands to the runner.

    A config ARC itself cannot load is reported as a failure rather than
    approximated, because a ceiling derived from a document the pipeline
    would reject is not evidence about the run that would follow.
    """
    import contextlib
    import hashlib
    import io

    from researchclaw.config import RCConfig

    config_path = Path(str(payload["config_path"])).resolve()
    raw = config_path.read_bytes()
    # check_paths=False keeps this a pure read: no directory is created and no
    # project layout has to exist just to learn what the ceiling would be.
    # stdout is captured because the caller parses this script's stdout as
    # JSON, and a profile the loader cannot find prints rather than raises.
    with contextlib.redirect_stdout(io.StringIO()):
        config = RCConfig.load(config_path, check_paths=False)

    budget = config.budget
    llm = config.llm
    experiment = config.experiment

    return {
        "success": True,
        "config_sha256": hashlib.sha256(raw).hexdigest(),
        "budget": {
            "enforcement": budget.enforcement,
            "policy_id": budget.policy_id,
            "provider": budget.provider,
            "max_calls": budget.max_calls,
            "max_prompt_tokens_per_call": budget.max_prompt_tokens_per_call,
            "max_completion_tokens_per_call": budget.max_completion_tokens_per_call,
            "max_prompt_tokens_total": budget.max_prompt_tokens_total,
            "max_completion_tokens_total": budget.max_completion_tokens_total,
            "max_usd_total": budget.max_usd_total,
            "allow_preflight": budget.allow_preflight,
            "models": [
                {
                    "model": entry.model,
                    "max_completion_tokens": entry.max_completion_tokens,
                }
                for entry in budget.models
            ],
        },
        "llm": {
            "provider": llm.provider,
            "primary_model": llm.primary_model,
            "fallback_models": list(llm.fallback_models),
        },
        "experiment": {
            "opencode_enabled": bool(experiment.opencode.enabled),
            "repair_enabled": bool(experiment.repair.enabled),
            "repair_uses_opencode": bool(experiment.repair.use_opencode),
            "cli_agent_provider": str(experiment.cli_agent.provider),
            "gemini_image_enabled": bool(experiment.figure_agent.nano_banana_enabled),
        },
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
    elif action == "gate_rollback":
        result = _gate_rollback(payload)
    elif action == "budget_policy":
        result = _budget_policy(payload)
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
