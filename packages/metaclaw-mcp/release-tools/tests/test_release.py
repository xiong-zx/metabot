from __future__ import annotations

import json
import os
import shutil
import stat
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import sys

TOOL_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOL_ROOT))

import release_lib


class ReleaseInstallerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = Path(tempfile.mkdtemp(prefix="metaclaw-release-test-"))
        self.source = self.temporary / "source-checkout"
        self.source.mkdir(mode=0o700)
        self.release_root = self.temporary / "release-root"
        self.old_manifest = self.temporary / "old-manifest.json"
        self.old_manifest.write_text(
            json.dumps(
                {
                    "schema_version": "metabot.metaclaw.release.v1",
                    "release_id": "0.4.1-aea4f3382d56",
                    "commit": "aea4f3382d561ed0718a7419bba13616663d67a9",
                }
            ),
            encoding="utf-8",
        )

    def tearDown(self) -> None:
        release_lib._make_writable(self.temporary)
        import shutil

        shutil.rmtree(self.temporary)

    @staticmethod
    def _extract(_source: Path, destination: Path, _revision: str) -> None:
        destination.mkdir(mode=0o700)
        (destination / "metaclaw.py").write_text("candidate\n", encoding="utf-8")

    @staticmethod
    def _build(
        source: Path,
        payload: Path,
        _python: Path,
        _epoch: str,
        _seed: Path | None = None,
        published_payload: Path | None = None,
    ) -> dict[str, object]:
        wheels = payload / "wheels"
        wheels.mkdir(mode=0o700)
        wheel = wheels / "aiming_metaclaw-0.4.1-py3-none-any.whl"
        wheel.write_bytes(b"wheel fixture\n")
        venv = payload / "venv"
        (venv / "bin").mkdir(parents=True, mode=0o700)
        (venv / "lib" / "python" / "site-packages" / "aiming_metaclaw-0.4.1.dist-info").mkdir(
            parents=True, mode=0o700
        )
        console = venv / "bin" / "metaclaw"
        console.write_text(
            "#!/bin/sh\n"
            "'''exec' \"$(dirname \"$0\")/python3.11\" \"$0\" \"$@\"\n"
            "' '''\n",
            encoding="utf-8",
        )
        console.chmod(0o700)
        python = venv / "bin" / "python3.11"
        # A byte-copy of a macOS framework launcher is not relocatable: its
        # Mach-O load command expects ``../Python3`` beside the copied binary.
        # The fixture needs an ordinary executable that preserves argv and
        # works on every supported test host; the real installer still creates
        # its candidate with ``python -m venv --copies``.
        python.write_text(f'#!/bin/sh\nexec "{sys.executable}" "$@"\n', encoding="utf-8")
        python.chmod(0o700)
        freeze = payload / "requirements.freeze.txt"
        freeze.write_text("aiming-metaclaw==0.4.1\npip==25.1\n", encoding="utf-8")
        return {
            "wheel": wheel,
            "venv": venv,
            "python": python,
            "console": console,
            "freeze": freeze,
            "freezeEntries": 2,
            "dependencySource": {"kind": "pip_resolved"},
            "pythonVersion": sys.version.split()[0],
        }

    def _install(self) -> dict[str, object]:
        series = release_lib.load_series()
        verified = {"path": str(self.source.resolve()), "head": series["candidateCommit"], "tree": series["candidateTree"]}
        with (
            patch.object(release_lib, "verify_source", return_value=verified),
            patch.object(release_lib, "_git", return_value="1700000000"),
            patch.object(release_lib, "_extract_git_archive", side_effect=self._extract),
            patch.object(release_lib, "_build_and_install", side_effect=self._build),
        ):
            return release_lib.install_release(
                source_arg=str(self.source.resolve()),
                release_root_arg=str(self.release_root.resolve()),
                superseded_manifest_arg=str(self.old_manifest.resolve()),
            )

    def test_install_is_append_only_and_repeat_is_byte_identical(self) -> None:
        old_before = self.old_manifest.read_bytes()
        old_stat = self.old_manifest.stat()
        first = self._install()
        manifest_path = Path(str(first["manifestPath"]))
        before = manifest_path.read_bytes()
        before_stat = manifest_path.stat()

        second = self._install()

        self.assertTrue(first["installed"])
        self.assertFalse(second["installed"])
        self.assertTrue(second["reused"])
        self.assertEqual(before, manifest_path.read_bytes())
        self.assertEqual(before_stat.st_mtime_ns, manifest_path.stat().st_mtime_ns)
        self.assertFalse(first["official"])
        self.assertTrue(first["nonEditable"])
        self.assertTrue(first["sourceReadonly"])
        self.assertTrue(first["venvReadonly"])
        self.assertTrue(first["consoleExecutable"])
        self.assertFalse(first["manifest"]["official"])
        self.assertFalse(first["manifest"]["provenance"]["official"])
        self.assertEqual(first["manifest"]["supersedes"]["releaseId"], "0.4.1-aea4f3382d56")
        self.assertEqual(self.old_manifest.read_bytes(), old_before)
        self.assertEqual(self.old_manifest.stat().st_mtime_ns, old_stat.st_mtime_ns)

    def test_doctor_fails_closed_on_digest_writable_and_symlink_drift(self) -> None:
        installed = self._install()
        manifest = installed["manifest"]
        root = Path(manifest["root"])
        candidate = root / "source" / "metaclaw.py"

        candidate.chmod(0o644)
        with self.assertRaisesRegex(release_lib.ReleaseError, "writable file"):
            release_lib.doctor_release(str(installed["manifestPath"]))
        candidate.chmod(0o444)

        candidate.chmod(0o644)
        candidate.write_text("drifted!!\n", encoding="utf-8")
        candidate.chmod(0o444)
        with self.assertRaisesRegex(release_lib.ReleaseError, "file drift"):
            release_lib.doctor_release(str(installed["manifestPath"]))

        candidate.chmod(0o644)
        candidate.write_text("candidate\n", encoding="utf-8")
        candidate.chmod(0o444)
        candidate.parent.chmod(0o755)
        candidate.unlink()
        os.symlink(str(self.old_manifest), candidate)
        with self.assertRaisesRegex(release_lib.ReleaseError, "symlink"):
            release_lib.doctor_release(str(installed["manifestPath"]))

    def test_source_verifier_requires_the_exact_ordered_series(self) -> None:
        series = release_lib.load_series()
        commands = {
            ("rev-parse", "HEAD"): series["candidateCommit"],
            ("rev-parse", "HEAD^{tree}"): series["candidateTree"],
            ("status", "--porcelain", "--untracked-files=all"): "",
            ("rev-parse", f"{series['baseCommit']}^{{tree}}"): series["baseTree"],
            ("rev-parse", f"refs/tags/{series['tag']}^{{commit}}"): series["tagCommit"],
            ("rev-list", "--reverse", f"{series['baseCommit']}..{series['candidateCommit']}"): "\n".join(
                item["commit"] for item in series["patches"]
            ),
        }
        for item in series["patches"]:
            commands[("rev-parse", f"{item['commit']}^{{tree}}")] = item["tree"]
            commands[("log", "-1", "--format=%s", item["commit"])] = item["subject"]

        def fake_git(_source: Path, *args: str) -> str:
            return commands[args]

        with patch.object(release_lib, "_git", side_effect=fake_git), patch.object(
            release_lib, "_run", return_value=release_lib.CommandResult("", "")
        ):
            verified = release_lib.verify_source(str(self.source.resolve()), series)
        self.assertEqual(verified["head"], series["candidateCommit"])
        self.assertEqual(len(series["patches"]), 24)
        self.assertEqual(release_lib.patch_series_digest(series["patches"]), series["seriesSha256"])

    def test_git_archive_extraction_is_python39_compatible_and_rejects_unsafe_nodes(self) -> None:
        safe_destination = self.temporary / "safe-extract"

        def safe_archive(argv: list[str], **_kwargs: object) -> release_lib.CommandResult:
            archive = Path(next(item.split("=", 1)[1] for item in argv if item.startswith("--output=")))
            payload = self.temporary / "payload.txt"
            payload.write_text("safe\n", encoding="utf-8")
            with tarfile.open(archive, "w") as bundle:
                bundle.add(payload, arcname="nested/payload.txt")
            return release_lib.CommandResult("", "")

        with patch.object(release_lib, "_run", side_effect=safe_archive):
            release_lib._extract_git_archive(self.source, safe_destination, "revision")
        self.assertEqual((safe_destination / "nested" / "payload.txt").read_text(encoding="utf-8"), "safe\n")

        unsafe_destination = self.temporary / "unsafe-extract"

        def unsafe_archive(argv: list[str], **_kwargs: object) -> release_lib.CommandResult:
            archive = Path(next(item.split("=", 1)[1] for item in argv if item.startswith("--output=")))
            with tarfile.open(archive, "w") as bundle:
                member = tarfile.TarInfo("../escape.txt")
                member.size = 0
                bundle.addfile(member)
            return release_lib.CommandResult("", "")

        with patch.object(release_lib, "_run", side_effect=unsafe_archive):
            with self.assertRaisesRegex(release_lib.ReleaseError, "unsafe path or node"):
                release_lib._extract_git_archive(self.source, unsafe_destination, "revision")
        self.assertFalse((self.temporary.parent / "escape.txt").exists())

    def test_manifest_and_payload_remain_owner_nonwritable_after_install(self) -> None:
        installed = self._install()
        manifest_path = Path(str(installed["manifestPath"]))
        self.assertEqual(stat.S_IMODE(manifest_path.stat().st_mode), 0o444)
        root = Path(installed["manifest"]["root"])
        for target in [root, root / "source", root / "venv"]:
            self.assertEqual(stat.S_IMODE(target.stat().st_mode) & 0o222, 0)

    def test_doctor_rejects_manifest_and_directory_mode_or_superseded_evidence_drift(self) -> None:
        installed = self._install()
        manifest_path = Path(str(installed["manifestPath"]))
        root = Path(installed["manifest"]["root"])

        manifest_path.chmod(0o644)
        with self.assertRaisesRegex(release_lib.ReleaseError, "manifest is writable"):
            release_lib.doctor_release(str(manifest_path))
        manifest_path.chmod(0o444)

        source = root / "source"
        source.chmod(0o755)
        with self.assertRaisesRegex(release_lib.ReleaseError, "writable directory|directory mode drift"):
            release_lib.doctor_release(str(manifest_path))
        source.chmod(0o555)

        self.old_manifest.write_text("{}\n", encoding="utf-8")
        with self.assertRaisesRegex(release_lib.ReleaseError, "evidence changed"):
            release_lib.doctor_release(str(manifest_path))

    def test_existing_candidate_symlink_cannot_escape_the_release_root(self) -> None:
        series = release_lib.load_series()
        releases = self.release_root / "releases"
        releases.mkdir(parents=True)
        escaped = self.temporary / "escaped-candidate"
        escaped.mkdir()
        os.symlink(escaped, releases / series["releaseId"])
        with self.assertRaisesRegex(release_lib.ReleaseError, "contained plain release directory"):
            self._install()

    def test_wheel_build_uses_a_disposable_copy_and_cannot_dirty_sealed_source(self) -> None:
        source = self.temporary / "archive-source"
        source.mkdir()
        (source / "metaclaw.py").write_text("exact tree\n", encoding="utf-8")
        payload = self.temporary / "payload"
        payload.mkdir()

        def fake_run(argv: list[str], **_kwargs: object) -> release_lib.CommandResult:
            if argv[1:4] == ["-m", "pip", "wheel"]:
                build_source = Path(argv[-1])
                (build_source / "build").mkdir()
                (build_source / "build" / "generated.txt").write_text("dirty\n", encoding="utf-8")
                wheel_dir = Path(argv[argv.index("--wheel-dir") + 1])
                (wheel_dir / "aiming_metaclaw-0.4.1-py3-none-any.whl").write_bytes(b"wheel\n")
            elif argv[1:4] == ["-m", "venv", "--copies"]:
                venv = Path(argv[-1])
                (venv / "bin").mkdir(parents=True)
                python = venv / "bin" / "python3"
                python.write_bytes(b"python\n")
                python.chmod(0o700)
            elif argv[1:4] == ["-m", "pip", "install"]:
                console = Path(argv[0]).parent / "metaclaw"
                console.write_text("#!/usr/bin/env python3\n", encoding="utf-8")
                console.chmod(0o700)
                wheel = Path(argv[-1])
                marker = console.parent.parent / "lib" / "python3.11" / "site-packages" / "aiming_metaclaw-0.4.1.dist-info" / "direct_url.json"
                marker.parent.mkdir(parents=True)
                marker.write_text(
                    json.dumps(
                        {
                            "archive_info": {"hash": f"sha256={release_lib.sha256_file(wheel)}"},
                            "url": wheel.resolve().as_uri(),
                        }
                    ),
                    encoding="utf-8",
                )
            elif argv[1:4] == ["-m", "pip", "list"]:
                return release_lib.CommandResult("aiming-metaclaw==0.4.1\n", "")
            elif len(argv) > 1 and argv[1] == "-c":
                return release_lib.CommandResult("3.11.0\n", "")
            return release_lib.CommandResult("", "")

        with patch.object(release_lib, "_run", side_effect=fake_run):
            built = release_lib._build_and_install(source, payload, Path(sys.executable), "1700000000")

        self.assertEqual((source / "metaclaw.py").read_text(encoding="utf-8"), "exact tree\n")
        self.assertFalse((source / "build").exists())
        self.assertEqual(Path(built["freeze"]).read_text(encoding="utf-8"), "aiming-metaclaw==0.4.1\n")
        self.assertEqual(list(Path(built["venv"]).rglob("direct_url.json")), [])


if __name__ == "__main__":
    unittest.main()
