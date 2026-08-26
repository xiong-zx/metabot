from __future__ import annotations

import json
import hashlib
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import sys

TOOL_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOL_ROOT))

import profile_lib


class ManagedProfileTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = Path(tempfile.mkdtemp(prefix="metaclaw-profile-test-"))
        self.profiles = self.temporary / "profiles"
        self.release_dir = self.temporary / "release"
        self.payload = self.release_dir / "payload"
        (self.payload / "venv" / "bin").mkdir(parents=True)
        self.console = self.payload / "venv" / "bin" / "metaclaw"
        self.console.write_text("#!/usr/bin/env python3\n", encoding="utf-8")
        self.console.chmod(0o555)
        self.manifest_path = self.release_dir / "manifest.json"
        self.manifest_path.write_text("{}\n", encoding="utf-8")
        self.manifest_path.chmod(0o444)
        self.release_report = {
            "ok": True,
            "official": False,
            "state": "downstream_patched_candidate",
            "releaseId": "0.4.1+mcpsec.2-396ff44",
            "manifestPath": str(self.manifest_path.resolve()),
            "manifestSha256": "a" * 64,
            "manifest": {
                "root": str(self.payload.resolve()),
                "immutability": {"consoleScript": "venv/bin/metaclaw"},
                "supersedes": {
                    "releaseId": "0.4.1-aea4f3382d56",
                    "manifestPath": "/official/manifest.json",
                    "manifestSha256": "b" * 64,
                    "reason": "fixture supersession",
                },
                "provenance": {"seriesSha256": "c" * 64},
            },
        }
        arc_commit = "b" * 40
        arc_tree = "c" * 40
        arc_series = "d" * 64
        self.arc_manifest_path = self.temporary / "arc-mclaw014-manifest.json"
        self.arc_manifest_path.write_text(
            json.dumps(
                {
                    "schema_version": profile_lib.ARC_RELEASE_SCHEMA,
                    "release_id": "unofficial-0.5.0-bbbbbbbbbbbb-hard-budget-mclaw014",
                    "state": "candidate",
                    "role": "mcp-execution",
                    "commit": arc_commit,
                    "source_tree": arc_tree,
                    "provenance": {
                        "official": False,
                        "class": "downstream-patched-candidate",
                        "series_sha256": arc_series,
                    },
                    "immutability": {"mode": "recursive-read-only", "sealed": ["source", "venv"]},
                    "assurances": [
                        {
                            "schema_version": profile_lib.ARC_ASSURANCE_SCHEMA,
                            "id": "MCLAW-014",
                            "commit": arc_commit,
                            "source_tree": arc_tree,
                            "patch_series_sha256": arc_series,
                        }
                    ],
                },
                indent=2,
                sort_keys=True,
            )
            + "\n",
            encoding="utf-8",
        )
        self.arc_manifest_path.chmod(0o444)

    def tearDown(self) -> None:
        import shutil

        shutil.rmtree(self.temporary)

    def _create(
        self,
        profile_id: str = "mclaw-inactive",
        port: int = 19412,
        bind_mclaw014: bool = False,
    ) -> dict[str, object]:
        with patch.object(profile_lib, "doctor_release", return_value=self.release_report):
            return profile_lib.create_profile(
                profiles_root_arg=str(self.profiles.resolve()),
                profile_id_arg=profile_id,
                manifest_arg=str(self.manifest_path.resolve()),
                port=port,
                model_arg="inactive-placeholder",
                provider_arg="inactive-placeholder",
                arc_manifest_arg=str(self.arc_manifest_path.resolve()) if bind_mclaw014 else None,
            )

    def _doctor(self, profile_path: Path) -> dict[str, object]:
        with patch.object(profile_lib, "doctor_release", return_value=self.release_report):
            return profile_lib.doctor_profile(str(profile_path), str(self.manifest_path.resolve()))

    def _snapshot(self, profile_path: Path) -> dict[str, object]:
        with patch.object(profile_lib, "doctor_release", return_value=self.release_report):
            return profile_lib.snapshot_skills(str(profile_path), str(self.manifest_path.resolve()))

    def test_creates_an_inactive_contained_profile_with_exact_permissions_and_pins(self) -> None:
        report = self._create()
        profile = report["profile"]
        profile_root = Path(profile["profileRoot"])

        self.assertTrue(report["created"])
        self.assertEqual(report["activation"]["state"], "inactive")
        self.assertEqual(report["bearer"], {"state": "placeholder", "protected": True})
        self.assertEqual(report["process"], {"state": "absent", "active": False, "identityVerified": True})
        self.assertEqual(report["allowedHosts"], ["127.0.0.1", "localhost"])
        self.assertEqual(
            report["remainingGates"],
            ["MCLAW-013", "MCLAW-002", "MCLAW-003", "MCLAW-004", "MCLAW-005", "MCLAW-015", "MCLAW-006"],
        )
        for path in (
            profile_root,
            Path(profile["managedHome"]),
            Path(profile["stateRoot"]),
            Path(profile["skills"]["root"]),
            Path(profile["rollback"]["snapshotsDir"]),
        ):
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700)
        for path in (
            Path(report["profilePath"]),
            Path(profile["service"]["bearerFile"]),
            Path(profile["service"]["configFile"]),
            Path(profile["service"]["authFile"]),
            Path(profile["rollback"]["initialSnapshot"]),
        ):
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        config = json.loads(Path(profile["service"]["configFile"]).read_text(encoding="utf-8"))
        self.assertEqual(config["mode"], "skills_only")
        self.assertFalse(config["skills"]["auto_evolve"])
        self.assertFalse(config["memory"]["enabled"])
        self.assertFalse(config["scheduler"]["enabled"])
        self.assertFalse(config["rl"]["enabled"])
        self.assertFalse(config["record"]["enabled"])
        self.assertFalse(config["openclaw"]["autoconfigure"])
        self.assertFalse(config["proxy"]["expose_admin_routes"])
        self.assertFalse(config["proxy"]["expose_memory_routes"])
        self.assertEqual(config["proxy"]["host"], "127.0.0.1")

    def test_repeat_creation_is_byte_identical_and_does_not_activate(self) -> None:
        first = self._create()
        profile_path = Path(first["profilePath"])
        before = profile_path.read_bytes()
        before_stat = profile_path.stat()

        second = self._create()

        self.assertFalse(second["created"])
        self.assertTrue(second["reused"])
        self.assertEqual(before, profile_path.read_bytes())
        self.assertEqual(before_stat.st_mtime_ns, profile_path.stat().st_mtime_ns)
        self.assertFalse(Path(second["profile"]["service"]["process"]["pidFile"]).exists())

    def test_binds_mclaw014_only_to_one_sealed_arc_manifest(self) -> None:
        report = self._create("mclaw014-bound", 19414, bind_mclaw014=True)
        profile = report["profile"]
        evidence = profile["externalEvidence"]["MCLAW-014"]

        self.assertEqual(evidence["manifestPath"], str(self.arc_manifest_path.resolve()))
        self.assertEqual(profile["gates"]["MCLAW-014"], {
            "satisfied": True,
            "evidence": evidence["manifestSha256"],
        })
        self.assertEqual(report["externalEvidence"], {"MCLAW-014": evidence})

        body = json.loads(self.arc_manifest_path.read_text(encoding="utf-8"))
        body["assurances"][0]["source_tree"] = "e" * 40
        self.arc_manifest_path.chmod(0o644)
        self.arc_manifest_path.write_text(json.dumps(body), encoding="utf-8")
        self.arc_manifest_path.chmod(0o444)
        with self.assertRaisesRegex(profile_lib.ReleaseError, "not tied"):
            self._doctor(Path(report["profilePath"]))

    def test_skills_snapshot_is_complete_idempotent_and_rejects_inflight_writes(self) -> None:
        created = self._create()
        profile = created["profile"]
        profile_path = Path(created["profilePath"])
        skills_root = Path(profile["skills"]["root"])
        skill = skills_root / "research"
        skill.mkdir(mode=0o700)
        skill_file = skill / "SKILL.md"
        skill_file.write_text("# Research\n", encoding="utf-8")
        skill_file.chmod(0o600)

        first = self._snapshot(profile_path)
        second = self._snapshot(profile_path)
        self.assertTrue(first["complete"])
        self.assertEqual(first["entryCount"], 1)
        self.assertTrue(first["created"])
        self.assertTrue(second["reused"])
        self.assertEqual(first["setDigest"], second["setDigest"])
        snapshot = json.loads(Path(first["snapshotPath"]).read_text(encoding="utf-8"))
        self.assertEqual(snapshot["writer"], "arc")
        self.assertEqual(snapshot["entries"][0]["sha256"], hashlib.sha256(b"# Research\n").hexdigest())

        temporary = skill / "SKILL.md.tmp"
        temporary.write_text("half", encoding="utf-8")
        temporary.chmod(0o600)
        with self.assertRaisesRegex(profile_lib.ReleaseError, "in-flight write marker"):
            self._snapshot(profile_path)

    def test_missing_pin_unsafe_path_and_wide_secret_fail_closed(self) -> None:
        created = self._create()
        profile_path = Path(created["profilePath"])
        profile = json.loads(profile_path.read_text(encoding="utf-8"))

        del profile["pins"]["openclaw.autoconfigure"]
        profile_path.write_text(json.dumps(profile), encoding="utf-8")
        profile_path.chmod(0o600)
        with self.assertRaisesRegex(profile_lib.ReleaseError, "missing or contradicts"):
            self._doctor(profile_path)

        profile["pins"] = dict(profile_lib.REQUIRED_PINS)
        profile["stateRoot"] = str(self.temporary / "escape")
        profile_path.write_text(json.dumps(profile), encoding="utf-8")
        with self.assertRaisesRegex(profile_lib.ReleaseError, "isolated layout"):
            self._doctor(profile_path)

        profile["stateRoot"] = str(profile_path.parent / "state")
        profile_path.write_text(json.dumps(profile), encoding="utf-8")
        bearer = Path(profile["service"]["bearerFile"])
        bearer.chmod(0o644)
        with self.assertRaisesRegex(profile_lib.ReleaseError, "0600"):
            self._doctor(profile_path)

    def test_reserves_each_loopback_port_once(self) -> None:
        self._create("first", 19412)
        with self.assertRaisesRegex(profile_lib.ReleaseError, "already reserved"):
            self._create("second", 19412)

    def test_release_doctor_runs_on_every_profile_doctor_call(self) -> None:
        created = self._create()
        with patch.object(profile_lib, "doctor_release", return_value=self.release_report) as doctor:
            profile_lib.doctor_profile(created["profilePath"], str(self.manifest_path.resolve()))
            profile_lib.doctor_profile(created["profilePath"], str(self.manifest_path.resolve()))
        self.assertEqual(doctor.call_count, 2)

    def test_creation_does_not_start_a_process_or_touch_direct_cli_or_user_home(self) -> None:
        fake_home = self.temporary / "operator-home"
        fake_home.mkdir()
        direct_cli = self.temporary / "bin" / "metaclaw"
        direct_cli.parent.mkdir()
        direct_cli.write_text("official-v0.4.1\n", encoding="utf-8")
        before = direct_cli.read_bytes()
        before_stat = direct_cli.stat()

        with patch.dict("os.environ", {"HOME": str(fake_home)}), patch.object(
            profile_lib.subprocess, "run", side_effect=AssertionError("profile creation started or inspected a process")
        ):
            created = self._create()

        self.assertTrue(created["created"])
        self.assertEqual(direct_cli.read_bytes(), before)
        self.assertEqual(direct_cli.stat().st_mtime_ns, before_stat.st_mtime_ns)
        self.assertFalse((fake_home / ".metaclaw").exists())
        self.assertFalse((fake_home / ".openclaw").exists())
        self.assertFalse(Path(created["profile"]["managedHome"], ".openclaw").exists())

    def test_profile_doctor_rejects_gate_rollback_openclaw_and_layout_drift(self) -> None:
        created = self._create()
        profile_path = Path(created["profilePath"])
        profile = json.loads(profile_path.read_text(encoding="utf-8"))

        profile["gates"]["MCLAW-012"]["evidence"] = "lying-release"
        profile_path.write_text(json.dumps(profile), encoding="utf-8")
        profile_path.chmod(0o600)
        with self.assertRaisesRegex(profile_lib.ReleaseError, "evidence drifted"):
            self._doctor(profile_path)

        profile = created["profile"]
        profile_path.write_text(json.dumps(profile), encoding="utf-8")
        snapshot_path = Path(profile["rollback"]["initialSnapshot"])
        snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
        snapshot["runtimeStarted"] = True
        snapshot_path.write_text(json.dumps(snapshot), encoding="utf-8")
        snapshot_path.chmod(0o600)
        profile["rollback"]["initialSnapshotSha256"] = profile_lib.sha256_file(snapshot_path)
        profile_path.write_text(json.dumps(profile), encoding="utf-8")
        with self.assertRaisesRegex(profile_lib.ReleaseError, "no-mutation evidence"):
            self._doctor(profile_path)

        openclaw = Path(profile["managedHome"]) / ".openclaw"
        openclaw.mkdir(mode=0o700)
        with self.assertRaisesRegex(profile_lib.ReleaseError, "contains .openclaw"):
            self._doctor(profile_path)

    def test_pid_and_process_identity_diagnostics_fail_on_stale_pid(self) -> None:
        created = self._create()
        profile = created["profile"]
        pid_path = Path(profile["service"]["process"]["pidFile"])
        identity_path = Path(profile["service"]["process"]["identityFile"])
        pid_path.write_text("99999999\n", encoding="ascii")
        pid_path.chmod(0o600)
        identity = {
            "pid": 99999999,
            "profileId": profile["profileId"],
            "releaseId": profile["release"]["releaseId"],
            "executable": profile["service"]["process"]["executable"],
            "managedHome": profile["managedHome"],
            "commandSha256": hashlib.sha256(b"missing").hexdigest(),
        }
        identity_path.write_text(json.dumps(identity), encoding="utf-8")
        identity_path.chmod(0o600)
        with self.assertRaisesRegex(profile_lib.ReleaseError, "no observable process"):
            self._doctor(Path(created["profilePath"]))

    def test_pid_without_identity_and_reused_pid_command_fail_closed_without_signalling(self) -> None:
        created = self._create()
        profile = created["profile"]
        pid_path = Path(profile["service"]["process"]["pidFile"])
        identity_path = Path(profile["service"]["process"]["identityFile"])
        pid_path.write_text("4242\n", encoding="ascii")
        pid_path.chmod(0o600)
        with self.assertRaisesRegex(profile_lib.ReleaseError, "process identity is missing"):
            self._doctor(Path(created["profilePath"]))

        identity = {
            "pid": 4242,
            "profileId": profile["profileId"],
            "releaseId": profile["release"]["releaseId"],
            "executable": profile["service"]["process"]["executable"],
            "managedHome": profile["managedHome"],
            "commandSha256": hashlib.sha256(b"expected command").hexdigest(),
        }
        identity_path.write_text(json.dumps(identity), encoding="utf-8")
        identity_path.chmod(0o600)
        observed = profile_lib.subprocess.CompletedProcess(
            ["ps", "-ww", "-p", "4242", "-o", "command="], 0, stdout="different command\n", stderr=""
        )
        with patch.object(profile_lib.subprocess, "run", return_value=observed) as inspect:
            with self.assertRaisesRegex(profile_lib.ReleaseError, "reused"):
                self._doctor(Path(created["profilePath"]))
        inspect.assert_called_once_with(
            ["ps", "-ww", "-p", "4242", "-o", "command="],
            text=True,
            stdout=profile_lib.subprocess.PIPE,
            stderr=profile_lib.subprocess.PIPE,
            check=False,
        )


if __name__ == "__main__":
    unittest.main()
