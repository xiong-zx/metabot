#!/usr/bin/env python3
"""Narrow compatibility shims for the pinned official ResearchClaw release.

The adapter keeps the external checkout untouched. These shims only repair
known integration defects in v0.5.0 and deliberately fail closed if the
audited official function shapes drift.
"""

from __future__ import annotations

import inspect
import json
import textwrap
from collections.abc import Callable
from typing import Any


_ACP_CLIENTS: dict[tuple[object, ...], object] = {}


def _replace_function_source(
    function: Callable[..., object],
    replacements: tuple[tuple[str, str, int], ...],
) -> Callable[..., object]:
    source = textwrap.dedent(inspect.getsource(function))
    for before, after, expected_count in replacements:
        actual_count = source.count(before)
        if actual_count != expected_count:
            raise RuntimeError(
                f"Official compatibility target {function.__qualname__} drifted: "
                f"expected {expected_count} occurrence(s), found {actual_count}"
            )
        source = source.replace(before, after)
    namespace: dict[str, object] = {}
    exec(
        compile(
            source,
            inspect.getsourcefile(function) or "<official-compat>",
            "exec",
        ),
        function.__globals__,
        namespace,
    )
    replacement = namespace.get(function.__name__)
    if not callable(replacement):
        raise RuntimeError(f"Could not rebuild official compatibility target {function.__qualname__}")
    return replacement


def _patch_literature_collection() -> bool:
    from researchclaw.pipeline import executor
    from researchclaw.pipeline.stage_impls import _literature
    from researchclaw.pipeline.stages import Stage

    function = _literature._execute_literature_collect
    if "os" not in function.__code__.co_varnames:
        return False
    replacement = _replace_function_source(
        function,
        (("            import os\n", "", 1),),
    )
    replacement._metabot_literature_os_scope = True  # type: ignore[attr-defined]
    _literature._execute_literature_collect = replacement
    executor._STAGE_EXECUTORS[Stage.LITERATURE_COLLECT] = replacement
    return True


def _patch_acp_session_initialization() -> bool:
    from researchclaw.llm.acp_client import ACPClient

    function = ACPClient._ensure_session
    if getattr(function, "_metabot_session_timeout", False):
        return False
    timeout = 'errors="replace", timeout=30,'
    if timeout not in inspect.getsource(function):
        return False
    replacement = _replace_function_source(
        function,
        ((
            timeout,
            'errors="replace", timeout=max(30, min(self.config.timeout_sec, 300)),',
            2,
        ),),
    )
    replacement._metabot_session_timeout = True  # type: ignore[attr-defined]
    ACPClient._ensure_session = replacement
    return True


def _patch_acp_client_lifetime() -> bool:
    import researchclaw.llm as llm_module
    from researchclaw.pipeline import executor

    if getattr(llm_module.create_llm_client, "_metabot_cached_acp_factory", False):
        return False
    original = llm_module.create_llm_client

    def cached_create_llm_client(config: Any) -> object:
        if config.llm.provider != "acp":
            return original(config)
        acp = config.llm.acp
        key = (
            acp.agent,
            acp.cwd,
            getattr(acp, "acpx_command", ""),
            getattr(acp, "session_name", "researchclaw"),
            getattr(acp, "timeout_sec", 1800),
        )
        client = _ACP_CLIENTS.get(key)
        if client is None:
            client = original(config)
            _ACP_CLIENTS[key] = client
        return client

    cached_create_llm_client._metabot_cached_acp_factory = True  # type: ignore[attr-defined]
    llm_module.create_llm_client = cached_create_llm_client
    executor.create_llm_client = cached_create_llm_client
    return True


def apply_official_compatibility() -> dict[str, bool]:
    """Apply the audited v0.5.0 shims before the official CLI starts."""
    return {
        "literature_os_scope": _patch_literature_collection(),
        "acp_session_timeout": _patch_acp_session_initialization(),
        "acp_session_lifetime": _patch_acp_client_lifetime(),
    }


def check_official_compatibility() -> dict[str, object]:
    applied = apply_official_compatibility()
    from types import SimpleNamespace

    from researchclaw.llm.acp_client import ACPClient
    from researchclaw.pipeline import executor
    from researchclaw.pipeline.stage_impls import _literature
    from researchclaw.pipeline.stages import Stage

    probe_config = SimpleNamespace(
        llm=SimpleNamespace(
            provider="acp",
            acp=SimpleNamespace(
                agent="codex",
                cwd=".",
                acpx_command="",
                session_name="metabot-official-compat-probe",
                timeout_sec=1800,
            ),
        ),
    )
    first_client = executor.create_llm_client(probe_config)
    second_client = executor.create_llm_client(probe_config)
    healthy = (
        "os" not in _literature._execute_literature_collect.__code__.co_varnames
        and getattr(_literature._execute_literature_collect, "_metabot_literature_os_scope", False)
        and getattr(ACPClient._ensure_session, "_metabot_session_timeout", False)
        and executor._STAGE_EXECUTORS[Stage.LITERATURE_COLLECT]
        is _literature._execute_literature_collect
        and getattr(executor.create_llm_client, "_metabot_cached_acp_factory", False)
        and first_client is second_client
    )
    return {"success": healthy, "applied": applied}


if __name__ == "__main__":
    result = check_official_compatibility()
    print(json.dumps(result, sort_keys=True))
    raise SystemExit(0 if result["success"] else 1)
