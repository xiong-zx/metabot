"""Inactive, isolated MetaClaw managed-profile construction and diagnostics."""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import subprocess
from pathlib import Path
from typing import Any

from release_lib import PLACEHOLDER_BEARER, ReleaseError, doctor_release, sha256_file


PROFILE_SCHEMA = 1
SAFE_PROFILE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$")
SAFE_SKILL_NAME = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
HOSTS = ("127.0.0.1", "localhost")
ACTIVATION_REASON = (
    "MCLAW-013, MCLAW-002, MCLAW-003, MCLAW-004, MCLAW-005, MCLAW-015, and MCLAW-006 gates remain"
)
MCP_LIMITS = {
    "deadlineMs": 60_000,
    "localReadDeadlineMs": 120_000,
    "maxLocalEntries": 100_000,
    "maxLocalBytes": 1024 * 1024 * 1024,
    "maxRequestBytes": 256 * 1024,
    "maxResponseBytes": 1024 * 1024,
    "maxMessages": 32,
    "maxPromptBytes": 128 * 1024,
    "maxOutputTokens": 4_096,
}
COST_LIMITS = {
    "maxCalls": 1000,
    "maxInputTokens": 10_000_000,
    "maxOutputTokens": 1_000_000,
    "maxUsdMicros": 100_000_000,
    "inputUsdMicrosPerMillion": 1_000_000,
    "outputUsdMicrosPerMillion": 2_000_000,
}
UPSTREAM_BOUNDS = {
    "maxBodyBytes": 256 * 1024,
    "maxConcurrentRequests": 1,
    "queueWaitSeconds": 1,
    "requestTimeoutSeconds": 60,
    "submissionWaitSeconds": 5,
}
REQUIRED_PINS: dict[str, str | bool] = {
    "mode": "skills_only",
    "skills.auto_evolve": False,
    "memory.enabled": False,
    "scheduler.enabled": False,
    "rl.enabled": False,
    "wechat.enabled": False,
    "openclaw.autoconfigure": False,
    "record.enabled": False,
    "proxy.host": "127.0.0.1",
    "proxy.expose_admin_routes": False,
    "proxy.expose_memory_routes": False,
}


def _private_json(path: Path, value: Any) -> bytes:
    body = (json.dumps(value, indent=2, sort_keys=True, ensure_ascii=True) + "\n").encode("utf-8")
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(body)
        handle.flush()
        os.fsync(handle.fileno())
    path.chmod(0o600)
    return body


def _private_text(path: Path, body: str) -> bytes:
    encoded = body.encode("utf-8")
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(encoded)
        handle.flush()
        os.fsync(handle.fileno())
    path.chmod(0o600)
    return encoded


def _mkdir(path: Path) -> None:
    path.mkdir(mode=0o700)
    path.chmod(0o700)


def _contained(root: Path, target: Path, label: str) -> None:
    if not target.is_absolute():
        raise ReleaseError(f"{label} must be absolute")
    try:
        target.relative_to(root)
    except ValueError as error:
        raise ReleaseError(f"{label} escapes the managed profile root") from error
    current = target
    while current != root.parent:
        if current.exists() or current.is_symlink():
            if current.is_symlink():
                raise ReleaseError(f"{label} traverses a symlink: {current}")
        if current == root:
            return
        current = current.parent
    raise ReleaseError(f"{label} is not contained by the managed profile root")


def _validate_text_pin(value: str, label: str) -> str:
    cleaned = value.strip()
    if not cleaned or len(cleaned) > 200 or any(character in cleaned for character in "\r\n\x00"):
        raise ReleaseError(f"{label} must be a non-empty single-line pin")
    return cleaned


def _read_private_json(path: Path, label: str) -> dict[str, Any]:
    try:
        info = path.lstat()
    except OSError as error:
        raise ReleaseError(f"{label} is missing or unreadable") from error
    if path.is_symlink() or not stat.S_ISREG(info.st_mode):
        raise ReleaseError(f"{label} must be a regular non-symlink file")
    if stat.S_IMODE(info.st_mode) != 0o600:
        raise ReleaseError(f"{label} must have mode 0600")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ReleaseError(f"{label} is invalid JSON") from error
    if not isinstance(value, dict):
        raise ReleaseError(f"{label} must contain an object")
    return value


def _assert_private_file(path: Path, label: str) -> None:
    try:
        info = path.lstat()
    except OSError as error:
        raise ReleaseError(f"{label} is missing or unreadable") from error
    if path.is_symlink() or not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600:
        raise ReleaseError(f"{label} must be a 0600 regular non-symlink file")


def _assert_private_directory(path: Path, label: str) -> None:
    try:
        info = path.lstat()
    except OSError as error:
        raise ReleaseError(f"{label} is missing or unreadable") from error
    if path.is_symlink() or not stat.S_ISDIR(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o700:
        raise ReleaseError(f"{label} must be a 0700 plain directory")


def _assert_profile_tree_modes(profile_root: Path) -> None:
    for directory, names, files in os.walk(profile_root, followlinks=False):
        current = Path(directory)
        _assert_private_directory(current, "managed profile directory")
        for name in names:
            target = current / name
            if target.is_symlink() or not target.is_dir():
                raise ReleaseError(f"managed profile contains an unsafe directory node: {target}")
        for name in files:
            _assert_private_file(current / name, "managed profile file")


def _reserve_port(profile_root: Path, port: int, profile_id: str) -> None:
    if not 1024 <= port <= 65535:
        raise ReleaseError("reserved port must be between 1024 and 65535")
    for child in profile_root.iterdir():
        if child.is_symlink():
            raise ReleaseError(f"unsafe profile entry while reserving port: {child}")
        if not child.is_dir() or child.name == profile_id:
            continue
        reservation = child / "port-reservation.json"
        if not reservation.exists():
            continue
        value = _read_private_json(reservation, "port reservation")
        if value.get("host") == "127.0.0.1" and value.get("port") == port:
            raise ReleaseError(f"loopback port {port} is already reserved by profile {value.get('profileId')}")


def _config(*, profile_dir: Path, model: str, provider: str, port: int) -> dict[str, Any]:
    return {
        "mode": "skills_only",
        "llm": {
            "provider": provider,
            "model_id": model,
            "api_base": "",
            "api_key": "",
            "allowed_models": [model],
        },
        "proxy": {
            "host": "127.0.0.1",
            "port": port,
            "api_key": PLACEHOLDER_BEARER,
            "allowed_hosts": list(HOSTS),
            "allowed_origins": [],
            "max_body_bytes": UPSTREAM_BOUNDS["maxBodyBytes"],
            "max_concurrent_requests": UPSTREAM_BOUNDS["maxConcurrentRequests"],
            "queue_wait_seconds": UPSTREAM_BOUNDS["queueWaitSeconds"],
            "request_timeout_seconds": UPSTREAM_BOUNDS["requestTimeoutSeconds"],
            "submission_wait_seconds": UPSTREAM_BOUNDS["submissionWaitSeconds"],
            "expose_admin_routes": False,
            "expose_memory_routes": False,
        },
        "skills": {
            "enabled": True,
            "dir": str(profile_dir / "shared-skills"),
            "retrieval_mode": "template",
            "auto_evolve": False,
        },
        "memory": {"enabled": False, "dir": str(profile_dir / "state" / "memory")},
        "scheduler": {"enabled": False},
        "rl": {"enabled": False},
        "wechat": {"enabled": False},
        "openclaw": {"autoconfigure": False},
        "record": {"enabled": False, "dir": str(profile_dir / "state" / "records")},
    }


def create_profile(
    *,
    profiles_root_arg: str,
    profile_id_arg: str,
    manifest_arg: str,
    port: int,
    model_arg: str,
    provider_arg: str,
) -> dict[str, Any]:
    release = doctor_release(manifest_arg)
    profile_id = _validate_text_pin(profile_id_arg, "profile id")
    if not SAFE_PROFILE_ID.fullmatch(profile_id):
        raise ReleaseError("profile id contains unsafe characters")
    model = _validate_text_pin(model_arg, "model")
    provider = _validate_text_pin(provider_arg, "provider")
    profiles_root = Path(profiles_root_arg)
    if not profiles_root.is_absolute():
        raise ReleaseError("profiles root must be absolute")
    profiles_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    _assert_private_directory(profiles_root, "profiles root")
    profiles_root = profiles_root.resolve(strict=True)
    _reserve_port(profiles_root, port, profile_id)
    profile_dir = profiles_root / profile_id
    profile_path = profile_dir / "profile.json"
    if profile_dir.exists() or profile_dir.is_symlink():
        report = doctor_profile(str(profile_path), manifest_arg)
        expected = {"profileId": profile_id, "model": model, "provider": provider, "port": port}
        actual = {
            "profileId": report["profileId"],
            "model": report["model"]["id"],
            "provider": report["model"]["provider"],
            "port": report["port"],
        }
        if actual != expected:
            raise ReleaseError("existing profile has different immutable pins")
        return {**report, "created": False, "reused": True}

    _mkdir(profile_dir)
    home = profile_dir / "home"
    state_root = profile_dir / "state"
    skills_root = profile_dir / "shared-skills"
    secrets = profile_dir / "secrets"
    rollback = profile_dir / "rollback"
    diagnostics = profile_dir / "diagnostics"
    for directory in (home, state_root, skills_root, secrets, rollback, diagnostics):
        _mkdir(directory)
    metaclaw_home = home / ".metaclaw"
    _mkdir(metaclaw_home)
    for directory in (state_root / "memory", state_root / "records"):
        _mkdir(directory)

    config_path = metaclaw_home / "config.yaml"
    auth_path = metaclaw_home / "auth.json"
    bearer_path = secrets / "service-bearer"
    pid_path = state_root / f"metaclaw-{port}.pid"
    identity_path = diagnostics / f"metaclaw-{port}.identity.json"
    reservation_path = profile_dir / "port-reservation.json"
    snapshot_path = rollback / "0001-inactive.json"
    release_manifest = release["manifest"]
    executable = Path(release_manifest["root"]) / release_manifest["immutability"]["consoleScript"]

    config = _config(profile_dir=profile_dir, model=model, provider=provider, port=port)
    config_body = _private_json(config_path, config)
    _private_json(
        auth_path,
        {
            "schemaVersion": 1,
            "state": "placeholder",
            "provider": provider,
            "credentials": {},
            "activationAllowed": False,
        },
    )
    _private_text(bearer_path, f"{PLACEHOLDER_BEARER}\n")
    _private_json(
        reservation_path,
        {
            "schemaVersion": 1,
            "profileId": profile_id,
            "host": "127.0.0.1",
            "port": port,
            "state": "inactive_reserved",
        },
    )
    snapshot = {
        "schemaVersion": 1,
        "profileId": profile_id,
        "state": "inactive",
        "candidate": {
            "releaseId": release["releaseId"],
            "manifestPath": release["manifestPath"],
            "manifestSha256": release["manifestSha256"],
        },
        "superseded": release_manifest["supersedes"],
        "configSha256": hashlib.sha256(config_body).hexdigest(),
        "selectorMutation": False,
        "directCliMutation": False,
        "runtimeStarted": False,
    }
    snapshot_body = _private_json(snapshot_path, snapshot)

    profile = {
        "schemaVersion": PROFILE_SCHEMA,
        "profileId": profile_id,
        "profileRoot": str(profile_dir),
        "activation": {
            "state": "inactive",
            "bearer": "placeholder",
            "reason": ACTIVATION_REASON,
        },
        "managedHome": str(home),
        "stateRoot": str(state_root),
        "release": {
            "manifestPath": release["manifestPath"],
            "releaseId": release["releaseId"],
            "official": False,
        },
        "service": {
            "endpoint": f"http://127.0.0.1:{port}",
            "bearerFile": str(bearer_path),
            "configFile": str(config_path),
            "authFile": str(auth_path),
            "allowedHosts": list(HOSTS),
            "identity": {"source": "health_body", "field": "release_id", "expect": release["releaseId"]},
            "upstreamBounds": dict(UPSTREAM_BOUNDS),
            "process": {
                "pidFile": str(pid_path),
                "identityFile": str(identity_path),
                "executable": str(executable),
                "workingDirectory": str(state_root),
                "managedHome": str(home),
            },
        },
        "model": {"id": model, "provider": provider},
        "cost": {"ledgerFile": str(state_root / "cost-ledger.json"), **COST_LIMITS},
        "skills": {
            "root": str(skills_root),
            "writer": "arc",
            "maxEntries": 10_000,
            "maxFileBytes": 1024 * 1024,
        },
        "limits": dict(MCP_LIMITS),
        "pins": dict(REQUIRED_PINS),
        "rollback": {
            "snapshotsDir": str(rollback),
            "initialSnapshot": str(snapshot_path),
            "initialSnapshotSha256": hashlib.sha256(snapshot_body).hexdigest(),
        },
        "gates": {
            "MCLAW-010": {"satisfied": True, "evidence": release["manifestSha256"]},
            "MCLAW-011": {"satisfied": True, "evidence": release_manifest["provenance"]["seriesSha256"]},
            "MCLAW-012": {"satisfied": True, "evidence": release["releaseId"]},
        },
    }
    _private_json(profile_path, profile)
    return {**doctor_profile(str(profile_path), manifest_arg), "created": True, "reused": False}


def _check_exact_config(profile: dict[str, Any]) -> None:
    service = profile["service"]
    config = _read_private_json(Path(service["configFile"]), "MetaClaw config")
    expected = _config(
        profile_dir=Path(profile["profileRoot"]),
        model=profile["model"]["id"],
        provider=profile["model"]["provider"],
        port=int(str(service["endpoint"]).rsplit(":", 1)[1]),
    )
    if config != expected:
        raise ReleaseError("managed MetaClaw config drifted from the exact inactive profile")
    auth = _read_private_json(Path(service["authFile"]), "MetaClaw auth placeholder")
    if auth != {
        "schemaVersion": 1,
        "state": "placeholder",
        "provider": profile["model"]["provider"],
        "credentials": {},
        "activationAllowed": False,
    }:
        raise ReleaseError("managed auth placeholder drifted")
    bearer = Path(service["bearerFile"]).read_text(encoding="utf-8")
    if bearer != f"{PLACEHOLDER_BEARER}\n":
        raise ReleaseError("managed service bearer is not the protected placeholder contract")


def _process_diagnostic(profile: dict[str, Any]) -> dict[str, Any]:
    process = profile["service"]["process"]
    pid_path = Path(process["pidFile"])
    identity_path = Path(process["identityFile"])
    if not pid_path.exists() and not pid_path.is_symlink():
        if identity_path.exists() or identity_path.is_symlink():
            raise ReleaseError("process identity exists without a PID file")
        return {"state": "absent", "active": False, "identityVerified": True}
    _assert_private_file(pid_path, "PID file")
    try:
        pid = int(pid_path.read_text(encoding="ascii").strip())
    except (OSError, UnicodeError, ValueError) as error:
        raise ReleaseError("PID file is malformed") from error
    if pid <= 1:
        raise ReleaseError("PID file contains an unsafe process id")
    identity = _read_private_json(identity_path, "process identity")
    expected = {
        "pid": pid,
        "profileId": profile["profileId"],
        "releaseId": profile["release"]["releaseId"],
        "executable": process["executable"],
        "managedHome": process["managedHome"],
    }
    for key, value in expected.items():
        if identity.get(key) != value:
            raise ReleaseError(f"process identity {key} does not match the profile")
    command_hash = identity.get("commandSha256")
    if not isinstance(command_hash, str) or not re.fullmatch(r"[0-9a-f]{64}", command_hash):
        raise ReleaseError("process identity lacks a command digest")
    try:
        observed = subprocess.run(
            ["ps", "-ww", "-p", str(pid), "-o", "command="],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    except OSError as error:
        raise ReleaseError("PID file names no observable process (process inspection unavailable)") from error
    if observed.returncode != 0 or not observed.stdout.strip():
        raise ReleaseError("PID file names no observable process")
    if hashlib.sha256(observed.stdout.strip().encode("utf-8")).hexdigest() != command_hash:
        raise ReleaseError("PID was reused by a different process identity")
    if profile["activation"]["state"] == "inactive":
        raise ReleaseError("inactive profile unexpectedly has a verified live process")
    return {"state": "running", "active": True, "identityVerified": True, "pid": pid}


def snapshot_skills(profile_arg: str, manifest_arg: str) -> dict[str, Any]:
    """Capture a complete pre-activation digest set without mutating skills."""

    report = doctor_profile(profile_arg, manifest_arg)
    profile = report["profile"]
    if report["activation"]["state"] != "inactive" or report["process"]["active"]:
        raise ReleaseError("skills snapshot requires an inactive profile with no process")
    skills = profile["skills"]
    if skills.get("writer") != "arc":
        raise ReleaseError("skills snapshot requires ARC as the sole declared writer")
    root = Path(str(skills["root"]))
    _assert_private_directory(root, "shared skills root")
    max_entries = int(skills["maxEntries"])
    max_file_bytes = int(skills["maxFileBytes"])
    children = sorted(root.iterdir(), key=lambda child: child.name)
    if len(children) > max_entries:
        raise ReleaseError("shared skills root exceeds its complete snapshot entry bound")

    entries: list[dict[str, Any]] = []
    for child in children:
        name = child.name
        if not SAFE_SKILL_NAME.fullmatch(name):
            raise ReleaseError("shared skills snapshot found an unsafe skill name")
        child_info = child.lstat()
        if child.is_symlink() or not stat.S_ISDIR(child_info.st_mode):
            raise ReleaseError(f"shared skill is not a plain directory: {name}")
        observed = sorted(child.iterdir(), key=lambda entry: entry.name)
        if any(
            entry.name.endswith((".tmp", ".partial")) or entry.name.startswith(".tmp")
            for entry in observed
        ):
            raise ReleaseError(f"shared skill has an in-flight write marker: {name}")
        skill_file = child / "SKILL.md"
        before = skill_file.lstat()
        if skill_file.is_symlink() or not stat.S_ISREG(before.st_mode):
            raise ReleaseError(f"shared skill has no regular SKILL.md: {name}")
        if before.st_size > max_file_bytes:
            raise ReleaseError(f"shared skill exceeds its file bound: {name}")
        body = skill_file.read_bytes()
        after = skill_file.lstat()
        if (
            before.st_dev != after.st_dev
            or before.st_ino != after.st_ino
            or before.st_size != after.st_size
            or before.st_mtime_ns != after.st_mtime_ns
        ):
            raise ReleaseError(f"shared skill changed while snapshotting: {name}")
        entries.append(
            {
                "name": name,
                "writer": "arc",
                "relativePath": f"{name}/SKILL.md",
                "bytes": len(body),
                "modifiedAtNs": after.st_mtime_ns,
                "sha256": hashlib.sha256(body).hexdigest(),
            }
        )

    canonical = json.dumps(entries, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    set_digest = hashlib.sha256(canonical).hexdigest()
    snapshot = {
        "schemaVersion": 1,
        "profileId": profile["profileId"],
        "releaseId": profile["release"]["releaseId"],
        "state": "complete",
        "writer": "arc",
        "skillsRoot": str(root),
        "entryCount": len(entries),
        "setDigest": set_digest,
        "entries": entries,
    }
    snapshots_dir = Path(str(profile["rollback"]["snapshotsDir"]))
    _assert_private_directory(snapshots_dir, "rollback snapshots directory")
    snapshot_path = snapshots_dir / f"skills-{set_digest}.json"
    created = False
    if snapshot_path.exists() or snapshot_path.is_symlink():
        if _read_private_json(snapshot_path, "skills snapshot") != snapshot:
            raise ReleaseError("existing skills snapshot does not match its digest identity")
    else:
        _private_json(snapshot_path, snapshot)
        created = True
    return {
        "ok": True,
        "profileId": profile["profileId"],
        "releaseId": profile["release"]["releaseId"],
        "writer": "arc",
        "complete": True,
        "entryCount": len(entries),
        "setDigest": set_digest,
        "snapshotPath": str(snapshot_path),
        "snapshotSha256": sha256_file(snapshot_path),
        "created": created,
        "reused": not created,
    }


def doctor_profile(profile_arg: str, manifest_arg: str) -> dict[str, Any]:
    release = doctor_release(manifest_arg)
    profile_path = Path(profile_arg)
    if not profile_path.is_absolute():
        raise ReleaseError("profile path must be absolute")
    profile = _read_private_json(profile_path, "managed profile")
    required = {
        "schemaVersion",
        "profileId",
        "profileRoot",
        "activation",
        "managedHome",
        "stateRoot",
        "release",
        "service",
        "model",
        "cost",
        "skills",
        "limits",
        "pins",
        "rollback",
        "gates",
    }
    if set(profile) != required or profile.get("schemaVersion") != PROFILE_SCHEMA:
        raise ReleaseError("managed profile fields do not match the exact schema")
    profile_root = Path(str(profile["profileRoot"]))
    if profile_path.parent != profile_root or not profile_root.is_absolute():
        raise ReleaseError("profile root is not the profile file parent")
    if not SAFE_PROFILE_ID.fullmatch(str(profile["profileId"])) or profile_root.name != profile["profileId"]:
        raise ReleaseError("managed profile id/path mismatch")
    if profile.get("activation") != {
        "state": "inactive",
        "bearer": "placeholder",
        "reason": ACTIVATION_REASON,
    }:
        raise ReleaseError("profile is not the inactive placeholder contract")
    if profile.get("release") != {
        "manifestPath": release["manifestPath"],
        "releaseId": release["releaseId"],
        "official": False,
    }:
        raise ReleaseError("profile release pin does not match the verified official=false candidate")
    if profile.get("limits") != MCP_LIMITS or profile.get("pins") != REQUIRED_PINS:
        raise ReleaseError("profile is missing or contradicts an exact pin/request bound")
    service = profile.get("service")
    model = profile.get("model")
    cost = profile.get("cost")
    skills = profile.get("skills")
    rollback = profile.get("rollback")
    if not all(isinstance(value, dict) for value in (service, model, cost, skills, rollback)):
        raise ReleaseError("profile service/model/cost/skills/rollback block is malformed")
    if set(service) != {
        "endpoint",
        "bearerFile",
        "configFile",
        "authFile",
        "allowedHosts",
        "identity",
        "upstreamBounds",
        "process",
    }:
        raise ReleaseError("profile service block has an unknown or missing field")
    process_block = service.get("process")
    if not isinstance(process_block, dict) or set(process_block) != {
        "pidFile",
        "identityFile",
        "executable",
        "workingDirectory",
        "managedHome",
    }:
        raise ReleaseError("profile process block has an unknown or missing field")
    endpoint = str(service.get("endpoint", ""))
    match = re.fullmatch(r"http://127\.0\.0\.1:(\d{4,5})", endpoint)
    if not match or not 1024 <= int(match.group(1)) <= 65535:
        raise ReleaseError("profile endpoint is not an exact reserved loopback port")
    port = int(match.group(1))
    if service.get("allowedHosts") != list(HOSTS) or service.get("upstreamBounds") != UPSTREAM_BOUNDS:
        raise ReleaseError("profile allowed_hosts or upstream request bounds drifted")
    if service.get("identity") != {
        "source": "health_body",
        "field": "release_id",
        "expect": release["releaseId"],
    }:
        raise ReleaseError("profile endpoint identity pin drifted")
    if set(model) != {"id", "provider"} or not isinstance(model.get("id"), str) or not isinstance(
        model.get("provider"), str
    ):
        raise ReleaseError("profile model/provider pins are missing")
    if _validate_text_pin(model["id"], "model") != model["id"] or _validate_text_pin(
        model["provider"], "provider"
    ) != model["provider"]:
        raise ReleaseError("profile model/provider pins are not canonical")
    if cost != {"ledgerFile": str(profile_root / "state" / "cost-ledger.json"), **COST_LIMITS}:
        raise ReleaseError("profile mechanical cost policy drifted")
    if skills != {
        "root": str(profile_root / "shared-skills"),
        "writer": "arc",
        "maxEntries": 10_000,
        "maxFileBytes": 1024 * 1024,
    }:
        raise ReleaseError("profile shared-skills contract drifted")
    expected_executable = str(
        Path(release["manifest"]["root"]) / release["manifest"]["immutability"]["consoleScript"]
    )
    expected_paths = {
        "managedHome": str(profile_root / "home"),
        "stateRoot": str(profile_root / "state"),
        "bearerFile": str(profile_root / "secrets" / "service-bearer"),
        "configFile": str(profile_root / "home" / ".metaclaw" / "config.yaml"),
        "authFile": str(profile_root / "home" / ".metaclaw" / "auth.json"),
        "pidFile": str(profile_root / "state" / f"metaclaw-{port}.pid"),
        "identityFile": str(profile_root / "diagnostics" / f"metaclaw-{port}.identity.json"),
        "workingDirectory": str(profile_root / "state"),
        "costLedgerFile": str(profile_root / "state" / "cost-ledger.json"),
        "processManagedHome": str(profile_root / "home"),
        "snapshotsDir": str(profile_root / "rollback"),
        "initialSnapshot": str(profile_root / "rollback" / "0001-inactive.json"),
        "executable": expected_executable,
    }
    actual_paths = {
        "managedHome": profile["managedHome"],
        "stateRoot": profile["stateRoot"],
        "bearerFile": service.get("bearerFile"),
        "configFile": service.get("configFile"),
        "authFile": service.get("authFile"),
        "pidFile": process_block.get("pidFile"),
        "identityFile": process_block.get("identityFile"),
        "workingDirectory": process_block.get("workingDirectory"),
        "costLedgerFile": cost.get("ledgerFile"),
        "processManagedHome": process_block.get("managedHome"),
        "snapshotsDir": rollback.get("snapshotsDir"),
        "initialSnapshot": rollback.get("initialSnapshot"),
        "executable": process_block.get("executable"),
    }
    if actual_paths != expected_paths:
        raise ReleaseError("profile paths drifted from the exact isolated layout")
    expected_gates = {
        "MCLAW-010": {"satisfied": True, "evidence": release["manifestSha256"]},
        "MCLAW-011": {
            "satisfied": True,
            "evidence": release["manifest"]["provenance"]["seriesSha256"],
        },
        "MCLAW-012": {"satisfied": True, "evidence": release["releaseId"]},
    }
    if profile.get("gates") != expected_gates:
        raise ReleaseError("profile MCLAW-010/011/012 evidence drifted")
    paths = {
        "managed HOME": Path(profile["managedHome"]),
        "state root": Path(profile["stateRoot"]),
        "skills root": Path(skills.get("root", "")),
        "bearer file": Path(service.get("bearerFile", "")),
        "config file": Path(service.get("configFile", "")),
        "auth file": Path(service.get("authFile", "")),
        "PID file": Path(service.get("process", {}).get("pidFile", "")),
        "process identity file": Path(service.get("process", {}).get("identityFile", "")),
        "process working directory": Path(service.get("process", {}).get("workingDirectory", "")),
        "cost ledger": Path(cost.get("ledgerFile", "")),
        "rollback directory": Path(rollback.get("snapshotsDir", "")),
        "rollback snapshot": Path(rollback.get("initialSnapshot", "")),
    }
    for label, target in paths.items():
        _contained(profile_root, target, label)
    for label in ("managed HOME", "state root", "skills root", "process working directory", "rollback directory"):
        _assert_private_directory(paths[label], label)
    _assert_private_directory(profile_root, "profile root")
    _assert_private_directory(paths["managed HOME"] / ".metaclaw", "MetaClaw config directory")
    if (paths["managed HOME"] / ".openclaw").exists() or (paths["managed HOME"] / ".openclaw").is_symlink():
        raise ReleaseError("inactive managed HOME unexpectedly contains .openclaw")
    for label in ("bearer file", "config file", "auth file", "rollback snapshot"):
        _assert_private_file(paths[label], label)
    _assert_profile_tree_modes(profile_root)
    reservation = _read_private_json(profile_root / "port-reservation.json", "port reservation")
    if reservation != {
        "schemaVersion": 1,
        "profileId": profile["profileId"],
        "host": "127.0.0.1",
        "port": port,
        "state": "inactive_reserved",
    }:
        raise ReleaseError("profile loopback port reservation drifted")
    _check_exact_config(profile)
    snapshot = _read_private_json(paths["rollback snapshot"], "rollback snapshot")
    if sha256_file(paths["rollback snapshot"]) != rollback.get("initialSnapshotSha256"):
        raise ReleaseError("rollback snapshot digest drifted")
    expected_snapshot = {
        "schemaVersion": 1,
        "profileId": profile["profileId"],
        "state": "inactive",
        "candidate": {
            "releaseId": release["releaseId"],
            "manifestPath": release["manifestPath"],
            "manifestSha256": release["manifestSha256"],
        },
        "superseded": release["manifest"]["supersedes"],
        "configSha256": sha256_file(paths["config file"]),
        "selectorMutation": False,
        "directCliMutation": False,
        "runtimeStarted": False,
    }
    if snapshot != expected_snapshot:
        raise ReleaseError("rollback snapshot drifted from the exact inactive/no-mutation evidence")
    process = _process_diagnostic(profile)
    return {
        "ok": True,
        "profileId": profile["profileId"],
        "profilePath": str(profile_path.resolve(strict=True)),
        "profileSha256": sha256_file(profile_path),
        "activation": profile["activation"],
        "official": False,
        "releaseId": release["releaseId"],
        "releaseDoctor": {"ok": True, "manifestSha256": release["manifestSha256"]},
        "homeIsolated": True,
        "stateIsolated": True,
        "permissions": {"directories": "0700", "sensitiveFiles": "0600"},
        "bearer": {"state": "placeholder", "protected": True},
        "host": "127.0.0.1",
        "port": port,
        "portReservation": "inactive_reserved",
        "model": profile["model"],
        "allowedHosts": service["allowedHosts"],
        "limits": profile["limits"],
        "upstreamBounds": service["upstreamBounds"],
        "pins": profile["pins"],
        "process": process,
        "rollback": {
            "snapshot": rollback["initialSnapshot"],
            "snapshotSha256": rollback["initialSnapshotSha256"],
            "selectorMutation": False,
            "directCliMutation": False,
        },
        "remainingGates": ["MCLAW-013", "MCLAW-002", "MCLAW-003", "MCLAW-004", "MCLAW-005", "MCLAW-015", "MCLAW-006"],
        "profile": profile,
    }
