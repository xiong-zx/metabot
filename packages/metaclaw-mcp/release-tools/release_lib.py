"""Append-only MetaClaw downstream candidate release installation and verification.

This module is an operator tool.  It may invoke git and Python packaging tools,
but it never starts, stops, signals, or otherwise controls a MetaClaw process.
The stdio MCP server remains process-incapable in ``src/``.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Iterable


TOOL_ROOT = Path(__file__).resolve().parent
SERIES_FILE = TOOL_ROOT / "security-series.json"
MANIFEST_SCHEMA = 1
INTEGRATION_PACKAGE = "@xvirobotics/metaclaw-mcp"
INTEGRATION_VERSION = "0.1.0"
PLACEHOLDER_BEARER = "METABOT_METACLAW_BEARER_REQUIRED_DO_NOT_ACTIVATE"
MAX_MANIFEST_BYTES = 32 * 1024 * 1024
SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9+._-]{0,199}$")
FULL_SHA = re.compile(r"^[0-9a-f]{40}$")
DIGEST = re.compile(r"^[0-9a-f]{64}$")
EXACT_REQUIREMENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*==[^\s=]+$")

SUPERSESSION_REASON = (
    "Replaced append-only by the non-editable, recursively sealed official=false security candidate; "
    "old evidence is not rewritten."
)
PRIOR_CANDIDATE_REASON = (
    "The .1 candidate built its wheel in the archived source copy; .2 preserves .1 but seals an "
    "unmodified Git archive."
)

LIMITATIONS = (
    "official=false: this is a downstream-patched security candidate, not an upstream MetaClaw release",
    "the profile is inactive and carries a placeholder bearer; it cannot be activated as created",
    "streaming and upstream cancellation remain unsupported by the MetaClaw MCP integration",
    "bind identity is profile intent until an independently supervised process is verified",
    "MCLAW-013, MCLAW-002, MCLAW-003, MCLAW-004, MCLAW-005, MCLAW-015, and MCLAW-006 acceptance gates remain",
)


class ReleaseError(RuntimeError):
    """A fail-closed release or profile contract violation."""


@dataclass(frozen=True)
class CommandResult:
    stdout: str
    stderr: str


def _run(argv: list[str], *, cwd: Path | None = None, env: dict[str, str] | None = None) -> CommandResult:
    completed = subprocess.run(
        argv,
        cwd=cwd,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip() or f"exit {completed.returncode}"
        raise ReleaseError(f"command failed ({argv[0]}): {detail}")
    return CommandResult(completed.stdout, completed.stderr)


def _json_file(path: Path, *, max_bytes: int = MAX_MANIFEST_BYTES) -> dict[str, Any]:
    info = path.lstat()
    if path.is_symlink() or not stat.S_ISREG(info.st_mode):
        raise ReleaseError(f"unsafe JSON file: {path}")
    if info.st_size > max_bytes:
        raise ReleaseError(f"JSON file exceeds byte bound: {path}")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ReleaseError(f"invalid JSON file: {path}") from error
    if not isinstance(value, dict):
        raise ReleaseError(f"JSON document must be an object: {path}")
    return value


def load_series() -> dict[str, Any]:
    package = _json_file(TOOL_ROOT.parent / "package.json", max_bytes=1024 * 1024)
    if package.get("name") != INTEGRATION_PACKAGE or package.get("version") != INTEGRATION_VERSION:
        raise ReleaseError("release tooling integration package/version pin drifted from package.json")
    series = _json_file(SERIES_FILE)
    required = {
        "schemaVersion",
        "product",
        "version",
        "releaseId",
        "repository",
        "tag",
        "tagCommit",
        "baseCommit",
        "baseTree",
        "candidateCommit",
        "candidateTree",
        "seriesSha256",
        "patches",
    }
    if set(series) != required or series["schemaVersion"] != 1:
        raise ReleaseError("unsupported security-series schema")
    if not SAFE_ID.fullmatch(str(series["releaseId"])):
        raise ReleaseError("unsafe candidate release id")
    for key in ("tagCommit", "baseCommit", "baseTree", "candidateCommit", "candidateTree"):
        if not FULL_SHA.fullmatch(str(series[key])):
            raise ReleaseError(f"security-series {key} is not a full SHA-1")
    patches = series["patches"]
    if not isinstance(patches, list) or not patches:
        raise ReleaseError("security-series patch list is empty")
    for patch in patches:
        if not isinstance(patch, dict) or set(patch) != {"commit", "tree", "subject"}:
            raise ReleaseError("security-series patch entry is malformed")
        if not FULL_SHA.fullmatch(str(patch["commit"])) or not FULL_SHA.fullmatch(str(patch["tree"])):
            raise ReleaseError("security-series patch identity is malformed")
        if not isinstance(patch["subject"], str) or not patch["subject"].strip():
            raise ReleaseError("security-series patch subject is empty")
    if patch_series_digest(patches) != series["seriesSha256"]:
        raise ReleaseError("security-series digest does not cover its ordered commits and trees")
    return series


def patch_series_digest(patches: Iterable[dict[str, Any]]) -> str:
    payload = "".join(f"{entry['commit']}:{entry['tree']}\n" for entry in patches)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _stable_regular_digest(path: Path, label: str, *, require_read_only: bool = False) -> str:
    before = path.lstat()
    if path.is_symlink() or not stat.S_ISREG(before.st_mode):
        raise ReleaseError(f"{label} must be a regular non-symlink file")
    if require_read_only and stat.S_IMODE(before.st_mode) & 0o222:
        raise ReleaseError(f"{label} must be read-only")
    digest = sha256_file(path)
    after = path.lstat()
    if (
        before.st_dev != after.st_dev
        or before.st_ino != after.st_ino
        or before.st_size != after.st_size
        or before.st_mtime_ns != after.st_mtime_ns
    ):
        raise ReleaseError(f"{label} changed while it was read")
    return digest


def _absolute_plain_directory(path: Path, label: str, *, create: bool = False) -> Path:
    if not path.is_absolute():
        raise ReleaseError(f"{label} must be an absolute path")
    if create:
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = path.lstat()
    if path.is_symlink() or not stat.S_ISDIR(info.st_mode):
        raise ReleaseError(f"{label} is not a plain directory: {path}")
    return path.resolve(strict=True)


def _git(source: Path, *args: str) -> str:
    return _run(["git", "-C", str(source), *args]).stdout.strip()


def verify_source(source_arg: str, series: dict[str, Any]) -> dict[str, Any]:
    source = _absolute_plain_directory(Path(source_arg), "security-series source")
    head = _git(source, "rev-parse", "HEAD")
    if head != series["candidateCommit"]:
        raise ReleaseError(f"source HEAD mismatch: expected {series['candidateCommit']}, got {head}")
    tree = _git(source, "rev-parse", "HEAD^{tree}")
    if tree != series["candidateTree"]:
        raise ReleaseError(f"source tree mismatch: expected {series['candidateTree']}, got {tree}")
    if _git(source, "status", "--porcelain", "--untracked-files=all"):
        raise ReleaseError("security-series source is dirty")
    _run(["git", "-C", str(source), "merge-base", "--is-ancestor", series["baseCommit"], head])
    if _git(source, "rev-parse", f"{series['baseCommit']}^{{tree}}") != series["baseTree"]:
        raise ReleaseError("source upstream base tree does not match the pinned 922caf3 base")
    if _git(source, "rev-parse", f"refs/tags/{series['tag']}^{{commit}}") != series["tagCommit"]:
        raise ReleaseError("source v0.4.1 tag commit does not match the pin")
    commits = [line for line in _git(source, "rev-list", "--reverse", f"{series['baseCommit']}..{head}").splitlines() if line]
    expected = [entry["commit"] for entry in series["patches"]]
    if commits != expected:
        raise ReleaseError("source applies a different ordered security+baseline series")
    for entry in series["patches"]:
        if _git(source, "rev-parse", f"{entry['commit']}^{{tree}}") != entry["tree"]:
            raise ReleaseError(f"patch tree drift: {entry['commit']}")
        if _git(source, "log", "-1", "--format=%s", entry["commit"]) != entry["subject"]:
            raise ReleaseError(f"patch subject drift: {entry['commit']}")
    return {"path": str(source), "head": head, "tree": tree}


def _safe_relative(value: str) -> bool:
    if not value or "\\" in value or "\x00" in value:
        return False
    candidate = PurePosixPath(value)
    return not candidate.is_absolute() and all(part not in ("", ".", "..") for part in candidate.parts)


def _extract_git_archive(source: Path, destination: Path, revision: str) -> None:
    archive = destination.parent / "source.tar"
    _run(["git", "-C", str(source), "archive", "--format=tar", f"--output={archive}", revision])
    destination.mkdir(mode=0o700)
    with tarfile.open(archive, "r:") as bundle:
        for member in bundle.getmembers():
            name = member.name.rstrip("/")
            if not _safe_relative(name) or not (member.isdir() or member.isfile()):
                raise ReleaseError(f"git archive contains an unsafe path or node: {member.name!r}")
        # Python 3.9 has no ``filter=`` argument. Every member has already
        # been constrained to a safe relative regular file/directory, so the
        # validated extraction remains traversal- and link-safe there too.
        bundle.extractall(destination)
    archive.unlink()


def _packaging_environment(source_date_epoch: str) -> dict[str, str]:
    env = os.environ.copy()
    env.update(
        {
            "PIP_DISABLE_PIP_VERSION_CHECK": "1",
            "PIP_NO_INPUT": "1",
            "PYTHONHASHSEED": "0",
            "SOURCE_DATE_EPOCH": source_date_epoch,
        }
    )
    return env


def _build_and_install(
    source: Path,
    payload: Path,
    python: Path,
    source_date_epoch: str,
    dependency_seed_venv: Path | None = None,
    published_payload: Path | None = None,
) -> dict[str, Any]:
    wheels = payload / "wheels"
    wheels.mkdir(mode=0o700)
    env = _packaging_environment(source_date_epoch)
    build_source = payload.parent / "build-source"
    shutil.copytree(source, build_source, symlinks=False)
    try:
        _run(
            [
                str(python),
                "-m",
                "pip",
                "wheel",
                "--no-deps",
                "--no-build-isolation",
                "--wheel-dir",
                str(wheels),
                str(build_source),
            ],
            env=env,
        )
    finally:
        shutil.rmtree(build_source, ignore_errors=True)
    wheel_files = sorted(wheels.glob("*.whl"))
    if len(wheel_files) != 1:
        raise ReleaseError(f"expected one MetaClaw wheel, found {len(wheel_files)}")
    venv = payload / "venv"
    _run([str(python), "-m", "venv", "--copies", str(venv)], env=env)
    venv_python = venv / "bin" / "python3"
    if not venv_python.exists():
        venv_python = venv / "bin" / "python"
    dependency_source: dict[str, Any] = {"kind": "pip_resolved"}
    install_args = [str(venv_python), "-m", "pip", "install"]
    if dependency_seed_venv is not None:
        seed = _copy_seed_dependencies(dependency_seed_venv, venv, venv_python)
        dependency_source = {
            "kind": "seeded_official_v0.4.1",
            "venvPath": str(seed),
            "excludedEditable": ["metaclaw", "aiming_metaclaw-0.4.1.dist-info", "__editable__*"],
        }
        install_args.extend(["--no-index", "--no-deps", "--force-reinstall"])
    install_args.append(str(wheel_files[0]))
    _run(install_args, env=env)
    _rewrite_venv_shebangs(venv, (published_payload or payload) / "venv")
    _remove_metaclaw_direct_url(venv, wheel_files[0])
    freeze = _run([str(venv_python), "-m", "pip", "list", "--format=freeze"], env=env).stdout
    lines = sorted(
        (line.strip() for line in freeze.splitlines() if line.strip()),
        key=lambda line: line.split("==", 1)[0].lower().replace("_", "-"),
    )
    if not lines or any(not EXACT_REQUIREMENT.fullmatch(line) for line in lines):
        raise ReleaseError("dependency closure must contain only exact name==version pins")
    normalized_names = [line.split("==", 1)[0].lower().replace("_", "-") for line in lines]
    if len(set(normalized_names)) != len(normalized_names):
        raise ReleaseError("dependency closure contains duplicate normalized package names")
    if "aiming-metaclaw" not in normalized_names:
        raise ReleaseError("dependency closure does not contain the installed MetaClaw distribution")
    freeze_body = "".join(f"{line}\n" for line in lines)
    freeze_file = payload / "requirements.freeze.txt"
    freeze_file.write_text(freeze_body, encoding="utf-8")
    python_version = _run(
        [str(venv_python), "-c", "import sys; print(sys.version.split()[0])"], env=env
    ).stdout.strip()
    if not re.fullmatch(r"\d+\.\d+\.\d+", python_version):
        raise ReleaseError("candidate Python version is not a canonical release version")
    console = venv / "bin" / "metaclaw"
    if console.is_symlink() or not console.is_file():
        raise ReleaseError("installed MetaClaw console script is missing or unsafe")
    if not os.access(console, os.X_OK):
        raise ReleaseError("installed MetaClaw console script is not executable")
    _assert_non_editable(venv, source)
    return {
        "wheel": wheel_files[0],
        "venv": venv,
        "python": venv_python,
        "console": console,
        "freeze": freeze_file,
        "freezeEntries": len(lines),
        "dependencySource": dependency_source,
        "pythonVersion": python_version,
    }


def _remove_metaclaw_direct_url(venv: Path, wheel: Path) -> None:
    matches = list(venv.glob("lib/python*/site-packages/aiming_metaclaw-*.dist-info/direct_url.json"))
    if len(matches) != 1:
        raise ReleaseError(f"expected one MetaClaw direct_url marker, found {len(matches)}")
    marker = matches[0]
    value = _json_file(marker, max_bytes=1024 * 1024)
    archive = value.get("archive_info")
    expected_hash = f"sha256={sha256_file(wheel)}"
    if (
        value.get("dir_info") is not None
        or not isinstance(archive, dict)
        or archive.get("hash") != expected_hash
        or not str(value.get("url", "")).startswith("file:")
    ):
        raise ReleaseError("installed MetaClaw direct_url does not identify the built wheel")
    marker.unlink()


def _rewrite_venv_shebangs(venv: Path, _published_venv: Path) -> None:
    current = str(venv.resolve(strict=True)).encode("utf-8")
    prefix = b"#!" + current + b"/bin/"
    for script in (venv / "bin").iterdir():
        info = script.lstat()
        if script.is_symlink() or not stat.S_ISREG(info.st_mode):
            raise ReleaseError(f"virtualenv bin contains an unsafe node: {script}")
        with script.open("rb") as handle:
            first = handle.readline(4096).rstrip(b"\r\n")
        if first.startswith(prefix):
            interpreter_name = first[len(prefix) :]
            if not re.fullmatch(rb"python(?:\d+(?:\.\d+)?)?", interpreter_name):
                raise ReleaseError(f"virtualenv script uses an unsupported interpreter: {script}")
            body = script.read_bytes()
            _old, separator, rest = body.partition(b"\n")
            if not separator:
                raise ReleaseError(f"virtualenv script has no body after its shebang: {script}")
            # Absolute shebangs can exceed a host kernel's shebang limit once
            # an append-only release path is long. This standard shell/Python
            # polyglot trampoline stays relocatable and binds the entry point
            # to the sealed sibling interpreter without consulting PATH.
            trampoline = (
                b"#!/bin/sh\n'''exec' \"$(dirname \"$0\")/"
                + interpreter_name
                + b"\" \"$0\" \"$@\"\n' '''\n"
            )
            script.write_bytes(trampoline + rest)


def _copy_seed_dependencies(seed_venv: Path, venv: Path, venv_python: Path) -> Path:
    seed = _absolute_plain_directory(seed_venv, "dependency seed virtualenv")
    seed_python = seed / "bin" / "python3"
    if not seed_python.exists():
        seed_python = seed / "bin" / "python"
    if seed_python.is_symlink():
        # An ordinary venv interpreter link is acceptable as an input. It is
        # not copied into the candidate, whose own --copies venv is sealed.
        pass
    elif not seed_python.is_file():
        raise ReleaseError("dependency seed virtualenv has no Python interpreter")
    seed_site = Path(
        _run([str(seed_python), "-c", "import site; print(site.getsitepackages()[0])"]).stdout.strip()
    ).resolve(strict=True)
    new_site = Path(
        _run([str(venv_python), "-c", "import site; print(site.getsitepackages()[0])"]).stdout.strip()
    ).resolve(strict=True)
    if seed_site.is_symlink() or not seed_site.is_dir() or new_site.is_symlink() or not new_site.is_dir():
        raise ReleaseError("dependency seed or candidate site-packages directory is unsafe")
    for candidate in seed_site.rglob("*"):
        if candidate.is_symlink():
            raise ReleaseError(f"dependency seed contains a symlink: {candidate}")
    for existing in list(new_site.iterdir()):
        if existing.is_dir():
            shutil.rmtree(existing)
        else:
            existing.unlink()
    excluded = {"metaclaw", "aiming_metaclaw-0.4.1.dist-info"}
    for source_entry in sorted(seed_site.iterdir(), key=lambda item: item.name):
        if source_entry.name in excluded or source_entry.name.startswith("__editable__"):
            continue
        destination = new_site / source_entry.name
        if source_entry.is_dir():
            shutil.copytree(
                source_entry,
                destination,
                symlinks=False,
                ignore=shutil.ignore_patterns("__editable__*"),
            )
        elif not source_entry.name.startswith("__editable__"):
            shutil.copy2(source_entry, destination)
    return seed


def _assert_non_editable(venv: Path, source: Path) -> None:
    source_text = str(source.resolve())
    for candidate in venv.rglob("*"):
        info = candidate.lstat()
        if stat.S_ISLNK(info.st_mode):
            raise ReleaseError(f"installed virtualenv contains a symlink: {candidate}")
        if candidate.name.startswith("__editable__"):
            raise ReleaseError(f"editable install marker found: {candidate}")
        if candidate.suffix == ".pth" and candidate.is_file():
            text = candidate.read_text(encoding="utf-8", errors="replace")
            if "__editable__" in text or source_text in text or any(
                line.strip().startswith(("import ", "import\t")) and "distutils" not in line
                for line in text.splitlines()
            ):
                raise ReleaseError(f"editable or executable .pth file found: {candidate}")
        if candidate.name == "direct_url.json" and candidate.is_file():
            value = _json_file(candidate, max_bytes=1024 * 1024)
            if value.get("dir_info") is not None or not isinstance(value.get("archive_info"), dict):
                raise ReleaseError(f"installed distribution points at a local/editable source: {candidate}")


def _seal_tree(root: Path) -> None:
    for directory, names, files in os.walk(root, topdown=False, followlinks=False):
        current = Path(directory)
        for name in files:
            target = current / name
            info = target.lstat()
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
                raise ReleaseError(f"release contains an unsafe node: {target}")
            executable = bool(stat.S_IMODE(info.st_mode) & 0o111)
            target.chmod(0o555 if executable else 0o444)
        for name in names:
            target = current / name
            info = target.lstat()
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
                raise ReleaseError(f"release contains an unsafe directory: {target}")
            target.chmod(0o555)
        current.chmod(0o555)


def _inventory(root: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    files: list[dict[str, Any]] = []
    directories: list[dict[str, Any]] = []
    for directory, names, leaf_names in os.walk(root, followlinks=False):
        current = Path(directory)
        relative_directory = current.relative_to(root).as_posix()
        if relative_directory != ".":
            info = current.lstat()
            directories.append({"path": relative_directory, "mode": f"{stat.S_IMODE(info.st_mode):04o}"})
        for name in sorted(names):
            target = current / name
            if target.is_symlink() or not target.is_dir():
                raise ReleaseError(f"release contains an unsafe directory node: {target}")
        for name in sorted(leaf_names):
            target = current / name
            info = target.lstat()
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
                raise ReleaseError(f"release contains an unsafe file node: {target}")
            files.append(
                {
                    "path": target.relative_to(root).as_posix(),
                    "sha256": sha256_file(target),
                    "bytes": info.st_size,
                    "mode": f"{stat.S_IMODE(info.st_mode):04o}",
                }
            )
    files.sort(key=lambda item: item["path"])
    directories.sort(key=lambda item: item["path"])
    return files, directories


def _source_content_digest(files: Iterable[dict[str, Any]]) -> str:
    payload = "".join(
        f"{entry['path']}:{entry['bytes']}:{entry['sha256']}\n"
        for entry in sorted(files, key=lambda item: item["path"])
        if str(entry["path"]).startswith("source/")
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _manifest_bytes(value: dict[str, Any]) -> bytes:
    return (json.dumps(value, indent=2, sort_keys=True, ensure_ascii=True) + "\n").encode("utf-8")


def _read_superseded(manifest_arg: str) -> dict[str, Any]:
    path = Path(manifest_arg)
    if not path.is_absolute():
        raise ReleaseError("superseded manifest path must be absolute")
    value = _json_file(path)
    if value.get("schema_version") != "metabot.metaclaw.release.v1":
        raise ReleaseError("superseded manifest is not the exact installed official evidence format")
    if value.get("release_id") != "0.4.1-aea4f3382d56" or value.get("commit") != "aea4f3382d561ed0718a7419bba13616663d67a9":
        raise ReleaseError("superseded manifest is not the exact official v0.4.1 release")
    digest = _stable_regular_digest(path, "superseded official v0.4.1 manifest")
    return {
        "releaseId": value["release_id"],
        "manifestPath": str(path.resolve(strict=True)),
        "manifestSha256": digest,
        "reason": SUPERSESSION_REASON,
    }


def _read_prior_candidate(releases: Path) -> dict[str, Any] | None:
    prior_path = releases / "0.4.1+mcpsec.1-396ff44" / "manifest.json"
    if not prior_path.exists() and not prior_path.is_symlink():
        return None
    prior = _json_file(prior_path)
    if (
        prior.get("releaseId") != "0.4.1+mcpsec.1-396ff44"
        or prior.get("official") is not False
        or prior.get("state") != "downstream_patched_candidate"
    ):
        raise ReleaseError("prior .1 candidate evidence is malformed")
    prior_dir = prior_path.parent
    if prior_dir.is_symlink() or not prior_dir.is_dir() or prior_dir.parent.resolve(strict=True) != releases:
        raise ReleaseError("prior .1 candidate is not a contained plain release directory")
    return {
        "releaseId": prior["releaseId"],
        "manifestPath": str(prior_path.resolve(strict=True)),
        "manifestSha256": _stable_regular_digest(prior_path, "prior .1 candidate manifest", require_read_only=True),
        "reason": PRIOR_CANDIDATE_REASON,
    }


def install_release(
    *,
    source_arg: str,
    release_root_arg: str,
    superseded_manifest_arg: str,
    python_arg: str = sys.executable,
    dependency_seed_venv_arg: str | None = None,
) -> dict[str, Any]:
    series = load_series()
    source = verify_source(source_arg, series)
    release_root = _absolute_plain_directory(Path(release_root_arg), "release root", create=True)
    releases = release_root / "releases"
    releases.mkdir(mode=0o700, exist_ok=True)
    releases = _absolute_plain_directory(releases, "releases directory")
    target = releases / series["releaseId"]
    manifest_path = target / "manifest.json"
    supersedes = _read_superseded(superseded_manifest_arg)
    prior_candidate = _read_prior_candidate(releases)
    if target.exists() or target.is_symlink():
        if target.is_symlink() or not target.is_dir() or target.parent.resolve(strict=True) != releases:
            raise ReleaseError("existing candidate is not a contained plain release directory")
        report = doctor_release(str(manifest_path))
        manifest = report["manifest"]
        if manifest.get("supersedes") != supersedes:
            raise ReleaseError("existing candidate no longer points at the unchanged official v0.4.1 evidence")
        return {**report, "installed": False, "reused": True}

    dependency_seed_venv = Path(dependency_seed_venv_arg) if dependency_seed_venv_arg else None
    if dependency_seed_venv is not None:
        seed = _absolute_plain_directory(dependency_seed_venv, "dependency seed virtualenv")
        python = seed / "bin" / "python3"
        if not python.exists():
            python = seed / "bin" / "python"
        if not python.exists():
            raise ReleaseError("dependency seed virtualenv has no Python interpreter")
    else:
        python = Path(python_arg)
        if not python.is_absolute():
            located = shutil.which(python_arg)
            if not located:
                raise ReleaseError(f"Python executable not found: {python_arg}")
            python = Path(located)
    python = python.resolve(strict=True)
    epoch = _git(Path(source["path"]), "show", "-s", "--format=%ct", series["candidateCommit"])
    staging = Path(tempfile.mkdtemp(prefix=f".{series['releaseId']}.", dir=releases))
    try:
        payload = staging / "payload"
        payload.mkdir(mode=0o700)
        installed_source = payload / "source"
        _extract_git_archive(Path(source["path"]), installed_source, series["candidateCommit"])
        built = _build_and_install(
            installed_source,
            payload,
            python,
            epoch,
            dependency_seed_venv,
            target / "payload",
        )
        _seal_tree(payload)
        files, directories = _inventory(payload)
        wheel_relative = built["wheel"].relative_to(payload).as_posix()
        freeze_relative = built["freeze"].relative_to(payload).as_posix()
        console_relative = built["console"].relative_to(payload).as_posix()
        manifest: dict[str, Any] = {
            "schemaVersion": MANIFEST_SCHEMA,
            "releaseId": series["releaseId"],
            "product": series["product"],
            "version": series["version"],
            "official": False,
            "state": "downstream_patched_candidate",
            "tag": series["tag"],
            "commit": series["candidateCommit"],
            "root": str((target / "payload").resolve(strict=False)),
            "files": files,
            "directories": directories,
            "provenance": {
                "official": False,
                "class": "downstream_patched_candidate",
                "sourcePath": source["path"],
                "upstream": {
                    "repository": series["repository"],
                    "tag": series["tag"],
                    "tagCommit": series["tagCommit"],
                    "baseCommit": series["baseCommit"],
                    "baseTree": series["baseTree"],
                },
                "patches": series["patches"],
                "seriesSha256": series["seriesSha256"],
                "resultTree": series["candidateTree"],
                "installedSourceSha256": _source_content_digest(files),
            },
            "build": {
                "format": "wheel",
                "wheelFile": wheel_relative,
                "wheelSha256": next(item["sha256"] for item in files if item["path"] == wheel_relative),
                "editable": False,
                "sourceDateEpoch": int(epoch),
            },
            "dependencies": {
                "freezeFile": freeze_relative,
                "sha256": next(item["sha256"] for item in files if item["path"] == freeze_relative),
                "entries": built["freezeEntries"],
                "pythonVersion": built["pythonVersion"],
                "source": built["dependencySource"],
            },
            "immutability": {
                "mode": "recursive_read_only",
                "rootMode": "0555",
                "roots": ["source", "venv"],
                "consoleScript": console_relative,
            },
            "integration": {"package": INTEGRATION_PACKAGE, "version": INTEGRATION_VERSION},
            "supersedes": supersedes,
            "limitations": list(LIMITATIONS),
        }
        if prior_candidate is not None:
            manifest["priorCandidate"] = prior_candidate
        staging_manifest = staging / "manifest.json"
        staging_manifest.write_bytes(_manifest_bytes(manifest))
        staging_manifest.chmod(0o444)
        staging.chmod(0o555)
        staging.rename(target)
    except BaseException:
        _make_writable(staging)
        shutil.rmtree(staging, ignore_errors=True)
        raise
    report = doctor_release(str(manifest_path))
    return {**report, "installed": True, "reused": False}


def _make_writable(root: Path) -> None:
    if not root.exists() or root.is_symlink():
        return
    for directory, names, files in os.walk(root, topdown=False, followlinks=False):
        current = Path(directory)
        for name in files:
            target = current / name
            if not target.is_symlink():
                target.chmod(0o600)
        for name in names:
            target = current / name
            if not target.is_symlink():
                target.chmod(0o700)
        current.chmod(0o700)


def _require_dict(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ReleaseError(f"{label} must be an object")
    return value


def _require_list(value: Any, label: str) -> list[Any]:
    if not isinstance(value, list):
        raise ReleaseError(f"{label} must be an array")
    return value


def _validate_candidate_manifest(manifest: dict[str, Any], manifest_path: Path, series: dict[str, Any]) -> None:
    required = {
        "schemaVersion",
        "releaseId",
        "product",
        "version",
        "official",
        "state",
        "tag",
        "commit",
        "root",
        "files",
        "directories",
        "provenance",
        "build",
        "dependencies",
        "immutability",
        "integration",
        "supersedes",
        "limitations",
    }
    allowed = required | {"priorCandidate"}
    if not required.issubset(manifest) or not set(manifest).issubset(allowed):
        raise ReleaseError("candidate manifest fields do not match the exact schema")
    expected_scalars = {
        "schemaVersion": MANIFEST_SCHEMA,
        "releaseId": series["releaseId"],
        "product": series["product"],
        "version": series["version"],
        "official": False,
        "state": "downstream_patched_candidate",
        "tag": series["tag"],
        "commit": series["candidateCommit"],
    }
    for key, expected in expected_scalars.items():
        if manifest.get(key) != expected:
            raise ReleaseError(f"candidate manifest {key} does not match the pinned release")
    if manifest_path.parent.name != series["releaseId"]:
        raise ReleaseError("manifest release directory does not match releaseId")
    release_dir = manifest_path.parent
    if release_dir.is_symlink() or not release_dir.is_dir():
        raise ReleaseError("candidate release directory must be a plain directory")
    if stat.S_IMODE(release_dir.lstat().st_mode) != 0o555:
        raise ReleaseError("candidate release directory must have mode 0555")
    expected_root = (manifest_path.parent / "payload").resolve(strict=True)
    root_value = Path(str(manifest["root"]))
    if not root_value.is_absolute() or root_value.resolve(strict=True) != expected_root:
        raise ReleaseError("manifest payload root is not the contained release payload")
    integration = _require_dict(manifest["integration"], "integration")
    if integration != {"package": INTEGRATION_PACKAGE, "version": INTEGRATION_VERSION}:
        raise ReleaseError("candidate is paired to a different integration package/version")
    provenance = _require_dict(manifest["provenance"], "provenance")
    if provenance.get("official") is not False or provenance.get("class") != "downstream_patched_candidate":
        raise ReleaseError("candidate provenance may not claim official status")
    upstream = _require_dict(provenance.get("upstream"), "provenance.upstream")
    expected_upstream = {
        "repository": series["repository"],
        "tag": series["tag"],
        "tagCommit": series["tagCommit"],
        "baseCommit": series["baseCommit"],
        "baseTree": series["baseTree"],
    }
    if upstream != expected_upstream:
        raise ReleaseError("candidate upstream base provenance drifted")
    if provenance.get("patches") != series["patches"]:
        raise ReleaseError("candidate ordered patch provenance drifted")
    if provenance.get("seriesSha256") != series["seriesSha256"] or patch_series_digest(provenance["patches"]) != series["seriesSha256"]:
        raise ReleaseError("candidate patch series digest drifted")
    if provenance.get("resultTree") != series["candidateTree"]:
        raise ReleaseError("candidate result tree drifted")
    if not re.fullmatch(r"[0-9a-f]{64}", str(provenance.get("installedSourceSha256", ""))):
        raise ReleaseError("candidate installed-source content digest is missing")
    source_path = Path(str(provenance.get("sourcePath", "")))
    if not source_path.is_absolute():
        raise ReleaseError("candidate provenance sourcePath must be absolute")
    limitations = _require_list(manifest["limitations"], "limitations")
    if limitations != list(LIMITATIONS):
        raise ReleaseError("candidate limitations were removed or changed")

    build = _require_dict(manifest["build"], "build")
    if set(build) != {"format", "wheelFile", "wheelSha256", "editable", "sourceDateEpoch"}:
        raise ReleaseError("candidate build evidence has an unknown or missing field")
    dependencies = _require_dict(manifest["dependencies"], "dependencies")
    if set(dependencies) != {"freezeFile", "sha256", "entries", "pythonVersion", "source"}:
        raise ReleaseError("candidate dependency evidence has an unknown or missing field")
    immutability = _require_dict(manifest["immutability"], "immutability")
    if set(immutability) != {"mode", "rootMode", "roots", "consoleScript"}:
        raise ReleaseError("candidate immutability evidence has an unknown or missing field")
    supersedes = _require_dict(manifest["supersedes"], "supersedes")
    if set(supersedes) != {"releaseId", "manifestPath", "manifestSha256", "reason"} or supersedes.get(
        "releaseId"
    ) != "0.4.1-aea4f3382d56" or supersedes.get("reason") != SUPERSESSION_REASON:
        raise ReleaseError("candidate supersession evidence drifted")
    if "priorCandidate" in manifest:
        prior = _require_dict(manifest["priorCandidate"], "priorCandidate")
        if (
            set(prior) != {"releaseId", "manifestPath", "manifestSha256", "reason"}
            or prior.get("releaseId") != "0.4.1+mcpsec.1-396ff44"
            or prior.get("reason") != PRIOR_CANDIDATE_REASON
        ):
            raise ReleaseError("candidate prior-candidate evidence drifted")


def _verify_inventory(manifest: dict[str, Any], root: Path) -> dict[str, int]:
    listed_files: dict[str, dict[str, Any]] = {}
    for entry in _require_list(manifest["files"], "files"):
        item = _require_dict(entry, "file entry")
        if set(item) != {"path", "sha256", "bytes", "mode"} or not _safe_relative(str(item.get("path", ""))):
            raise ReleaseError("manifest contains an unsafe file path or shape")
        relative = str(item["path"])
        if relative in listed_files or not DIGEST.fullmatch(str(item.get("sha256", ""))):
            raise ReleaseError("manifest file entries are duplicate or malformed")
        if not isinstance(item.get("bytes"), int) or item["bytes"] < 0 or not re.fullmatch(r"0[45][0-7]{2}", str(item.get("mode", ""))):
            raise ReleaseError("manifest file size or mode is malformed")
        listed_files[relative] = item
    listed_dirs: dict[str, dict[str, Any]] = {}
    for entry in _require_list(manifest["directories"], "directories"):
        item = _require_dict(entry, "directory entry")
        if set(item) != {"path", "mode"} or not _safe_relative(str(item.get("path", ""))):
            raise ReleaseError("manifest contains an unsafe directory path or shape")
        relative = str(item["path"])
        if relative in listed_dirs or not re.fullmatch(r"0[45][0-7]{2}", str(item.get("mode", ""))):
            raise ReleaseError("manifest directory entries are duplicate or malformed")
        listed_dirs[relative] = item
    observed_files: set[str] = set()
    observed_dirs: set[str] = set()
    for directory, names, leaf_names in os.walk(root, followlinks=False):
        current = Path(directory)
        if current != root:
            observed_dirs.add(current.relative_to(root).as_posix())
        for name in names:
            target = current / name
            info = target.lstat()
            relative = target.relative_to(root).as_posix()
            if stat.S_ISLNK(info.st_mode):
                raise ReleaseError(f"release contains a symlink: {relative}")
            if not stat.S_ISDIR(info.st_mode):
                raise ReleaseError(f"release contains a non-directory node: {relative}")
        for name in leaf_names:
            target = current / name
            info = target.lstat()
            relative = target.relative_to(root).as_posix()
            if stat.S_ISLNK(info.st_mode):
                raise ReleaseError(f"release contains a symlink: {relative}")
            if not stat.S_ISREG(info.st_mode):
                raise ReleaseError(f"release contains a non-regular node: {relative}")
            observed_files.add(relative)
            expected = listed_files.get(relative)
            if expected is None:
                raise ReleaseError(f"release contains an unlisted file: {relative}")
            mode = stat.S_IMODE(info.st_mode)
            if mode & 0o222:
                raise ReleaseError(f"release contains a writable file: {relative}")
            if f"{mode:04o}" != expected["mode"] or info.st_size != expected["bytes"] or sha256_file(target) != expected["sha256"]:
                raise ReleaseError(f"release file drift: {relative}")
    if observed_files != set(listed_files):
        raise ReleaseError("release is missing one or more listed files")
    if observed_dirs != set(listed_dirs):
        extra = sorted(observed_dirs - set(listed_dirs))
        missing = sorted(set(listed_dirs) - observed_dirs)
        raise ReleaseError(f"release directory inventory drift: extra={extra[:3]}, missing={missing[:3]}")
    root_mode = stat.S_IMODE(root.lstat().st_mode)
    if root_mode != 0o555:
        raise ReleaseError("release payload root must have mode 0555")
    for relative, expected in listed_dirs.items():
        target = root / relative
        info = target.lstat()
        mode = stat.S_IMODE(info.st_mode)
        if mode & 0o222:
            raise ReleaseError(f"release contains a writable directory: {relative}")
        if f"{mode:04o}" != expected["mode"]:
            raise ReleaseError(f"release directory mode drift: {relative}")
    return {"files": len(observed_files), "directories": len(observed_dirs)}


def doctor_release(manifest_arg: str) -> dict[str, Any]:
    manifest_path = Path(manifest_arg)
    if not manifest_path.is_absolute():
        raise ReleaseError("release manifest path must be absolute")
    info = manifest_path.lstat()
    if manifest_path.is_symlink() or not stat.S_ISREG(info.st_mode):
        raise ReleaseError("release manifest must be a regular non-symlink file")
    if stat.S_IMODE(info.st_mode) & 0o222:
        raise ReleaseError("release manifest is writable")
    manifest = _json_file(manifest_path)
    series = load_series()
    _validate_candidate_manifest(manifest, manifest_path, series)
    root = Path(manifest["root"]).resolve(strict=True)
    counts = _verify_inventory(manifest, root)
    if _source_content_digest(manifest["files"]) != manifest["provenance"]["installedSourceSha256"]:
        raise ReleaseError("candidate installed source no longer matches its archived-source digest")
    build = _require_dict(manifest["build"], "build")
    if build.get("format") != "wheel" or build.get("editable") is not False:
        raise ReleaseError("candidate was not recorded as a non-editable wheel install")
    wheel = root / str(build.get("wheelFile", ""))
    if not _safe_relative(str(build.get("wheelFile", ""))) or sha256_file(wheel) != build.get("wheelSha256"):
        raise ReleaseError("candidate wheel evidence drifted")
    dependencies = _require_dict(manifest["dependencies"], "dependencies")
    dependency_source = _require_dict(dependencies.get("source"), "dependencies.source")
    if dependency_source.get("kind") not in {"pip_resolved", "seeded_official_v0.4.1"}:
        raise ReleaseError("candidate dependency source is unknown")
    if dependency_source.get("kind") == "seeded_official_v0.4.1":
        seed = Path(str(dependency_source.get("venvPath", "")))
        if set(dependency_source) != {"kind", "venvPath", "excludedEditable"} or not seed.is_absolute() or dependency_source.get(
            "excludedEditable"
        ) != ["metaclaw", "aiming_metaclaw-0.4.1.dist-info", "__editable__*"]:
            raise ReleaseError("candidate dependency seed evidence is malformed")
    elif set(dependency_source) != {"kind"}:
        raise ReleaseError("candidate resolved dependency source has unknown fields")
    freeze = root / str(dependencies.get("freezeFile", ""))
    if not _safe_relative(str(dependencies.get("freezeFile", ""))) or sha256_file(freeze) != dependencies.get("sha256"):
        raise ReleaseError("candidate dependency freeze drifted")
    lines = [line.strip() for line in freeze.read_text(encoding="utf-8").splitlines() if line.strip()]
    entries = len(lines)
    if entries != dependencies.get("entries") or any(not EXACT_REQUIREMENT.fullmatch(line) for line in lines):
        raise ReleaseError("candidate dependency freeze entry count drifted")
    names = [line.split("==", 1)[0].lower().replace("_", "-") for line in lines]
    if names != sorted(names) or len(names) != len(set(names)) or "aiming-metaclaw" not in names:
        raise ReleaseError("candidate dependency freeze is not a unique sorted exact closure")
    if not re.fullmatch(r"\d+\.\d+\.\d+", str(dependencies.get("pythonVersion", ""))):
        raise ReleaseError("candidate dependency Python version evidence is malformed")
    immutability = _require_dict(manifest["immutability"], "immutability")
    if (
        immutability.get("mode") != "recursive_read_only"
        or immutability.get("rootMode") != "0555"
        or immutability.get("roots") != ["source", "venv"]
    ):
        raise ReleaseError("candidate does not declare both executable trees recursively read-only")
    for relative in immutability["roots"]:
        target = root / relative
        if target.is_symlink() or not target.is_dir():
            raise ReleaseError(f"immutable release tree is missing or unsafe: {relative}")
    console_relative = str(immutability.get("consoleScript", ""))
    if not _safe_relative(console_relative):
        raise ReleaseError("candidate console script path is unsafe")
    console = root / console_relative
    console_info = console.lstat()
    if console.is_symlink() or not stat.S_ISREG(console_info.st_mode) or not (stat.S_IMODE(console_info.st_mode) & 0o111):
        raise ReleaseError("candidate console script is not a regular executable file")
    with console.open("rb") as handle:
        first_line = handle.readline(4096).rstrip(b"\r\n")
        second_line = handle.readline(4096).rstrip(b"\r\n")
        third_line = handle.readline(4096).rstrip(b"\r\n")
    trampoline_prefix = b"'''exec' \"$(dirname \"$0\")/"
    trampoline_suffix = b"\" \"$0\" \"$@\""
    if (
        first_line != b"#!/bin/sh"
        or third_line != b"' '''"
        or not second_line.startswith(trampoline_prefix)
        or not second_line.endswith(trampoline_suffix)
    ):
        raise ReleaseError("candidate console script does not use the sealed sibling-interpreter trampoline")
    interpreter_name = second_line[len(trampoline_prefix) : -len(trampoline_suffix)]
    if not re.fullmatch(rb"python(?:\d+(?:\.\d+)?)?", interpreter_name):
        raise ReleaseError("candidate console trampoline names an unsupported interpreter")
    interpreter = root / "venv" / "bin" / interpreter_name.decode("ascii")
    interpreter_info = interpreter.lstat()
    if interpreter.is_symlink() or not stat.S_ISREG(interpreter_info.st_mode) or not (
        stat.S_IMODE(interpreter_info.st_mode) & 0o111
    ):
        raise ReleaseError("candidate console interpreter is missing, unsafe, or non-executable")
    observed_python = _run(
        [str(interpreter), "-c", "import sys; print(sys.version.split()[0])"],
        env={"HOME": os.devnull, "PATH": os.defpath, "PYTHONDONTWRITEBYTECODE": "1", "LC_ALL": "C", "LANG": "C"},
    ).stdout.strip()
    if observed_python != dependencies["pythonVersion"]:
        raise ReleaseError("candidate console interpreter version drifted from dependency evidence")
    with tempfile.TemporaryDirectory(prefix="metaclaw-doctor-home-") as temporary_home:
        smoke_env = {
            "HOME": temporary_home,
            "XDG_CONFIG_HOME": f"{temporary_home}/config",
            "XDG_DATA_HOME": f"{temporary_home}/data",
            "XDG_CACHE_HOME": f"{temporary_home}/cache",
            "XDG_STATE_HOME": f"{temporary_home}/state",
            "PATH": os.defpath,
            "PYTHONDONTWRITEBYTECODE": "1",
            "LC_ALL": "C",
            "LANG": "C",
        }
        _run([str(console), "--help"], env=smoke_env)
    _assert_non_editable(root / "venv", root / "source")
    supersedes = _require_dict(manifest["supersedes"], "supersedes")
    old_manifest = Path(str(supersedes.get("manifestPath", "")))
    if not old_manifest.is_absolute() or _stable_regular_digest(
        old_manifest, "superseded official v0.4.1 manifest"
    ) != supersedes.get("manifestSha256"):
        raise ReleaseError("superseded official v0.4.1 evidence changed or disappeared")
    if "priorCandidate" in manifest:
        prior = _require_dict(manifest["priorCandidate"], "priorCandidate")
        prior_manifest = Path(str(prior.get("manifestPath", "")))
        if (
            prior.get("releaseId") != "0.4.1+mcpsec.1-396ff44"
            or not prior_manifest.is_absolute()
            or _stable_regular_digest(
                prior_manifest, "prior .1 candidate manifest", require_read_only=True
            ) != prior.get("manifestSha256")
        ):
            raise ReleaseError("prior .1 candidate evidence changed or disappeared")
    return {
        "ok": True,
        "official": False,
        "state": "downstream_patched_candidate",
        "releaseId": manifest["releaseId"],
        "manifestPath": str(manifest_path.resolve(strict=True)),
        "manifestSha256": sha256_file(manifest_path),
        "sourceReadonly": True,
        "venvReadonly": True,
        "consoleExecutable": True,
        "nonEditable": True,
        "inventory": counts,
        "limitations": manifest["limitations"],
        "manifest": manifest,
    }
