#!/usr/bin/env python3
"""Narrow compatibility shims for the pinned official ResearchClaw release.

The adapter keeps the external checkout untouched. These shims only repair
known integration defects in v0.5.0 and deliberately fail closed if the
audited official function shapes drift.
"""

from __future__ import annotations

import inspect
import json
import os
import tempfile
import textwrap
from collections.abc import Callable
from pathlib import Path
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


def _patch_code_agent_review_smoke_test() -> bool:
    """Re-run generated code after the review dialog mutates its files.

    ResearchClaw v0.5.0 runs its execution-fix loop before Phase 4 review.
    Review repairs can therefore introduce runtime-only failures that Stage 10
    incorrectly accepts and Stage 12 discovers much later. Reuse the official
    execution-fix loop, then fail closed if its final files still do not run.
    """
    from researchclaw.pipeline.code_agent import CodeAgent

    function = CodeAgent._phase4_review
    if getattr(function, "_metabot_post_review_smoke_test", False):
        return False
    replacement = _replace_function_source(
        function,
        ((
            "    return files, rounds\n",
            "    files = self._exec_fix_loop(files)\n"
            "    if self._sandbox_factory:\n"
            "        final_result = self._run_in_sandbox(files)\n"
            "        if final_result.returncode != 0 or final_result.timed_out:\n"
            "            stderr_tail = (final_result.stderr or '')[-1000:]\n"
            "            raise RuntimeError(\n"
            "                'CodeAgent post-review smoke test failed: '\n"
            "                f'rc={final_result.returncode}, '\n"
            "                f'timed_out={final_result.timed_out}, '\n"
            "                f'stderr={stderr_tail}'\n"
            "            )\n"
            "    return files, rounds\n",
            1,
        ),),
    )
    replacement._metabot_post_review_smoke_test = True  # type: ignore[attr-defined]
    CodeAgent._phase4_review = replacement
    return True


_MINIMAL_PROBE_CONFIG = """
project:
  name: budget-probe
  mode: docs-first
research:
  topic: Budget guard evidence probe
runtime:
  timezone: UTC
notifications:
  channel: none
knowledge_base:
  backend: markdown
  root: kb
openclaw_bridge: {}
llm:
  provider: openai-compatible
  base_url: http://budget-probe.invalid/v1
  api_key_env: METABOT_BUDGET_PROBE_KEY
  primary_model: claude-haiku-4-5
  fallback_models: []
budget:
  enforcement: required
"""


def _probe_budget_guard() -> dict[str, object]:
    """Prove the pinned release refuses unbounded billable dispatch.

    This is an *evidence* probe, not a shim: it never patches anything, and it
    never spends money.  Every assertion below is exercised against a refusal
    path, with the network transport replaced by a tripwire and no subprocess
    permitted, so a release that has the guard installed proves it fails closed
    and a release that lacks it reports that plainly instead of being assumed
    safe.

    Releases sealed before the guard existed report ``available: false``.  The
    surrounding shim check stays green for them so the existing non-billable
    path is untouched; it is the driver that refuses to start a bounded run
    against such a release.

    Nothing in here may raise.  The probe touches private upstream internals
    that a future release is free to rename, and turning that into an exception
    would take down the whole compatibility check — breaking the non-billable
    path this function promises not to affect.  An unexpected failure is
    reported as ``enforced: false`` with its reason, which blocks only the
    bounded-run gate.
    """
    try:
        from researchclaw import budget
    except Exception as exc:  # noqa: BLE001 - absence is a reportable fact
        return {
            "available": False,
            "enforced": False,
            "reason": f"module_absent: {type(exc).__name__}",
        }

    required = (
        "BudgetExceededError",
        "BudgetNotConfiguredError",
        "BudgetUnsupportedError",
        "ENFORCEMENT_ENV",
        "install_budget_guard",
        "require_guard_for_dispatch",
        "refuse_unsupported_dispatch",
        "reset_budget_guard",
    )
    missing = [name for name in required if not hasattr(budget, name)]
    if missing:
        return {"available": True, "enforced": False, "reason": f"api_missing: {missing}"}

    import urllib.request

    from researchclaw.llm import client as llm_client
    from researchclaw.llm.acp_client import ACPClient, ACPConfig

    checks: dict[str, bool] = {}
    previous_env = os.environ.get(budget.ENFORCEMENT_ENV)
    real_urlopen = urllib.request.urlopen
    network_attempts = 0
    probe_error = ""

    def _tripwire(*_args: object, **_kwargs: object) -> object:
        nonlocal network_attempts
        network_attempts += 1
        raise AssertionError("budget probe reached the network transport")

    try:
        budget.reset_budget_guard()
        urllib.request.urlopen = _tripwire  # type: ignore[assignment]

        # 1. ACP is declared structurally unbudgetable, not merely unconfigured.
        checks["acp_declared_unsupported"] = "acp" in budget.UNSUPPORTED_PROVIDERS

        # 2. With enforcement required and no guard, ACP refuses before acpx
        #    is spawned.  Constructing the client must not spawn anything.
        os.environ[budget.ENFORCEMENT_ENV] = "required"
        acp_client = ACPClient(ACPConfig(agent="codex", cwd="."))
        try:
            acp_client.chat([{"role": "user", "content": "probe"}])
            checks["acp_refused_before_spawn"] = False
        except budget.BudgetNotConfiguredError:
            checks["acp_refused_before_spawn"] = True
        except Exception:  # noqa: BLE001 - any other outcome is not proof
            checks["acp_refused_before_spawn"] = False

        # 3. An OpenAI-compatible client refuses too, without touching the net.
        openai_client = llm_client.LLMClient(
            llm_client.LLMConfig(
                base_url="https://budget-probe.invalid/v1",
                api_key="",
                provider="openai",
                primary_model="gpt-4o",
                fallback_models=[],
            )
        )
        try:
            openai_client.chat([{"role": "user", "content": "probe"}], max_tokens=8)
            checks["llm_refused_without_policy"] = False
        except budget.BudgetNotConfiguredError:
            checks["llm_refused_without_policy"] = True
        except Exception:  # noqa: BLE001
            checks["llm_refused_without_policy"] = False

        del os.environ[budget.ENFORCEMENT_ENV]

        # 4. A real policy's call ceiling is hard, and its ledger is durable.
        with tempfile.TemporaryDirectory(prefix="metabot-budget-probe-") as tmp:
            from decimal import Decimal

            ledger_path = os.path.join(tmp, "budget_ledger.jsonl")
            policy = budget.BudgetPolicy(
                policy_id="metabot-compat-probe",
                provider="anthropic",
                models=(
                    budget.ModelBound(
                        model="claude-haiku-4-5", max_completion_tokens=16
                    ),
                ),
                max_calls=1,
                max_prompt_tokens_per_call=4096,
                max_completion_tokens_per_call=16,
                max_prompt_tokens_total=4096,
                max_completion_tokens_total=16,
                max_usd_total=Decimal("0.01"),
            )
            guard = budget.install_budget_guard(policy, ledger_path)
            secret = "budget-probe-prompt-marker"
            guard.reserve(
                provider="anthropic",
                model="claude-haiku-4-5",
                messages=[{"role": "user", "content": secret}],
                effective_completion_cap=16,
            )
            try:
                guard.reserve(
                    provider="anthropic",
                    model="claude-haiku-4-5",
                    messages=[{"role": "user", "content": secret}],
                    effective_completion_cap=16,
                )
                checks["call_ceiling_is_hard"] = False
            except budget.BudgetExceededError:
                checks["call_ceiling_is_hard"] = True

            # 5. An unpriced model is refused rather than assumed free.
            try:
                guard.reserve(
                    provider="anthropic",
                    model="model-that-is-not-in-the-policy",
                    messages=[{"role": "user", "content": "probe"}],
                    effective_completion_cap=1,
                )
                checks["unknown_model_refused"] = False
            except budget.BudgetUnsupportedError:
                checks["unknown_model_refused"] = True

            with open(ledger_path, encoding="utf-8") as handle:
                ledger_text = handle.read()
            checks["ledger_written"] = '"kind":"reserve"' in ledger_text.replace(
                '"kind": "reserve"', '"kind":"reserve"'
            )
            checks["ledger_redacts_prompts"] = secret not in ledger_text

        # 6. The reservation is made against the value that goes on the wire,
        #    not the value the caller asked for.
        checks["reserves_effective_wire_cap"] = (
            openai_client._effective_completion_cap("gpt-5.2", 16) == 32768
        )

        # 7. A provider that reports nothing usable does not get refunded.
        #    Releasing a reservation on a zero usage report — which is what a
        #    missing usage block looks like once a parser has defaulted it —
        #    would let a run spend past its ceiling while appearing to be
        #    inside it.
        checks["zero_usage_is_not_released"] = _probe_zero_usage_kept(budget)

        # 8. Every billable path that never reaches LLMClient is enumerated as
        #    unbudgetable, and the two that spawn subprocesses refuse before
        #    they spawn.  A release that merely documents them as "disable
        #    these" cannot support a bounded run.
        unbudgetable = ("acp", "cli-agent", "opencode", "gemini-image", "embeddings")
        checks["other_billable_paths_declared"] = all(
            name in budget.UNSUPPORTED_PROVIDERS for name in unbudgetable
        )
        checks["code_agent_refused_before_spawn"] = _probe_code_agent_refusal(budget)
        checks["opencode_refused_before_spawn"] = _probe_opencode_refusal(budget)

        # 9. `researchclaw run` establishes the ceiling before its preflight,
        #    which is itself a billable call.  This is the entry point a
        #    bounded acceptance actually uses.
        checks["cli_run_refuses_before_preflight"] = _probe_cli_ordering(budget)
    except Exception as exc:  # noqa: BLE001 - a probe failure is reportable
        probe_error = f"probe_error: {type(exc).__name__}: {exc}"
    finally:
        urllib.request.urlopen = real_urlopen  # type: ignore[assignment]
        budget.reset_budget_guard()
        if previous_env is None:
            os.environ.pop(budget.ENFORCEMENT_ENV, None)
        else:
            os.environ[budget.ENFORCEMENT_ENV] = previous_env

    enforced = not probe_error and network_attempts == 0 and bool(checks) and all(checks.values())
    return {
        "available": True,
        "enforced": enforced,
        "checks": checks,
        "network_attempts": network_attempts,
        "price_table_version": getattr(budget, "PRICE_TABLE_VERSION", ""),
        "reason": "" if enforced else (probe_error or "checks_failed"),
    }


def _probe_zero_usage_kept(budget: Any) -> bool:
    """True when a zero usage report leaves the worst case charged."""
    from decimal import Decimal

    with tempfile.TemporaryDirectory(prefix="metabot-budget-zero-") as tmp:
        guard = budget.install_budget_guard(
            budget.BudgetPolicy(
                policy_id="metabot-zero-usage-probe",
                provider="anthropic",
                models=(
                    budget.ModelBound(
                        model="claude-haiku-4-5", max_completion_tokens=16
                    ),
                ),
                max_calls=2,
                max_prompt_tokens_per_call=4096,
                max_completion_tokens_per_call=16,
                max_prompt_tokens_total=4096,
                max_completion_tokens_total=32,
                max_usd_total=Decimal("0.01"),
            ),
            os.path.join(tmp, "budget_ledger.jsonl"),
        )
        reservation = guard.reserve(
            provider="anthropic",
            model="claude-haiku-4-5",
            messages=[{"role": "user", "content": "probe"}],
            effective_completion_cap=16,
        )
        reserved = guard.snapshot().usd_used
        guard.commit(
            reservation,
            prompt_tokens=0,
            completion_tokens=0,
            response_is_empty=True,
        )
        return guard.snapshot().usd_used == reserved


def _probe_code_agent_refusal(budget: Any) -> bool:
    """True when a CLI coding agent refuses before it spawns."""
    from researchclaw.experiment import code_agent as ca

    real_popen = ca.subprocess.Popen

    def _no_spawn(*_args: object, **_kwargs: object) -> object:
        raise AssertionError("code agent spawned under a budget regime")

    with tempfile.TemporaryDirectory(prefix="metabot-budget-agent-") as tmp:
        ca.subprocess.Popen = _no_spawn  # type: ignore[assignment]
        try:
            os.environ[budget.ENFORCEMENT_ENV] = "required"
            agent = ca._CliAgentBase(binary_path="claude")
            try:
                agent._run_subprocess(["claude", "-p", "probe"], Path(tmp), 5)
                return False
            except budget.BudgetError:
                return True
        finally:
            ca.subprocess.Popen = real_popen  # type: ignore[assignment]
            os.environ.pop(budget.ENFORCEMENT_ENV, None)


def _probe_opencode_refusal(budget: Any) -> bool:
    """True when the opencode bridge refuses before it spawns."""
    from researchclaw.pipeline import opencode_bridge as ob

    real_run = ob.subprocess.run

    def _no_spawn(*_args: object, **_kwargs: object) -> object:
        raise AssertionError("opencode spawned under a budget regime")

    with tempfile.TemporaryDirectory(prefix="metabot-budget-opencode-") as tmp:
        ob.subprocess.run = _no_spawn  # type: ignore[assignment]
        try:
            os.environ[budget.ENFORCEMENT_ENV] = "required"
            bridge = ob.OpenCodeBridge(model="probe-model")
            try:
                bridge._invoke_opencode(Path(tmp), "probe")
                return False
            except budget.BudgetError:
                return True
        finally:
            ob.subprocess.run = real_run  # type: ignore[assignment]
            os.environ.pop(budget.ENFORCEMENT_ENV, None)


def _probe_cli_ordering(budget: Any) -> bool:
    """True when `researchclaw run` refuses before it preflights.

    Preflight is a billable call.  A release that establishes the ceiling only
    inside ``execute_pipeline`` spends that call unbudgeted, so demanding
    enforcement with no policy must stop the run before the LLM client is even
    built.  Output is captured because the caller parses this script's stdout
    as JSON.
    """
    import argparse
    import contextlib
    import io

    from researchclaw import cli as rc_cli

    with tempfile.TemporaryDirectory(prefix="metabot-budget-cli-") as tmp:
        config_path = Path(tmp) / "config.yaml"
        config_path.write_text(_MINIMAL_PROBE_CONFIG.strip() + "\n", encoding="utf-8")
        args = argparse.Namespace(
            config=str(config_path),
            topic=None,
            output=str(Path(tmp) / "run"),
            from_stage=None,
            auto_approve=False,
            skip_preflight=False,
            resume=False,
            skip_noncritical_stage=False,
            no_graceful_degradation=False,
        )
        sink = io.StringIO()
        try:
            with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
                rc_cli.cmd_run(args)
            return False
        except budget.BudgetNotConfiguredError:
            return True


def apply_official_compatibility() -> dict[str, bool]:
    """Apply the audited v0.5.0 shims before the official CLI starts."""
    return {
        "literature_os_scope": _patch_literature_collection(),
        "acp_session_timeout": _patch_acp_session_initialization(),
        "acp_session_lifetime": _patch_acp_client_lifetime(),
        "code_agent_review_smoke_test": _patch_code_agent_review_smoke_test(),
    }


def check_official_compatibility() -> dict[str, object]:
    applied = apply_official_compatibility()
    from types import SimpleNamespace

    from researchclaw.llm.acp_client import ACPClient
    from researchclaw.pipeline import executor
    from researchclaw.pipeline.code_agent import CodeAgent
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
        and getattr(CodeAgent._phase4_review, "_metabot_post_review_smoke_test", False)
        and first_client is second_client
    )
    # Reported alongside, never folded into `success`: a release sealed before
    # the upstream guard existed must keep passing the shim check so the
    # existing non-billable path is unaffected.  The driver is what refuses to
    # start a bounded run when `enforced` is not true.
    return {
        "success": healthy,
        "applied": applied,
        "budget_guard": _probe_budget_guard(),
    }


if __name__ == "__main__":
    result = check_official_compatibility()
    print(json.dumps(result, sort_keys=True))
    raise SystemExit(0 if result["success"] else 1)
