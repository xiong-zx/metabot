#!/usr/bin/env python3
"""Operator CLI for append-only MetaClaw candidate releases and profiles."""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any

from profile_lib import create_profile, doctor_profile, snapshot_skills
from release_lib import ReleaseError, doctor_release, install_release


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="metaclaw-release")
    subcommands = parser.add_subparsers(dest="command", required=True)

    install = subcommands.add_parser("install", help="build and seal the pinned official=false candidate")
    install.add_argument("--source", required=True, help="absolute local security-series source checkout")
    install.add_argument("--release-root", required=True, help="absolute append-only release root")
    install.add_argument("--supersedes-manifest", required=True, help="absolute old official v0.4.1 manifest")
    install.add_argument("--python", default=sys.executable, help="base Python used to build the isolated virtualenv")
    install.add_argument(
        "--dependency-seed-venv",
        help="absolute official v0.4.1 venv used only as an offline dependency seed; editable MetaClaw files are excluded",
    )

    doctor = subcommands.add_parser("doctor", help="re-verify the sealed candidate and its old evidence")
    doctor.add_argument("--manifest", required=True, help="absolute candidate manifest path")

    profile = subcommands.add_parser("profile-create", help="create an inactive isolated managed profile")
    profile.add_argument("--profiles-root", required=True, help="absolute root containing isolated profiles")
    profile.add_argument("--profile-id", required=True)
    profile.add_argument("--manifest", required=True, help="absolute verified candidate manifest")
    profile.add_argument("--port", type=int, required=True, help="loopback port to reserve without binding")
    profile.add_argument("--model", required=True, help="exact pinned model id")
    profile.add_argument("--provider", required=True, help="exact pinned provider id")
    profile.add_argument(
        "--arc-manifest",
        help="absolute sealed ARC manifest carrying the MCLAW-014 assurance",
    )

    profile_doctor = subcommands.add_parser(
        "profile-doctor", help="re-verify release, isolation, permissions, process identity, and rollback"
    )
    profile_doctor.add_argument("--profile", required=True, help="absolute managed profile JSON")
    profile_doctor.add_argument("--manifest", required=True, help="absolute verified candidate manifest")

    snapshot = subcommands.add_parser(
        "skills-snapshot", help="capture one complete read-only ARC-owned skills digest set"
    )
    snapshot.add_argument("--profile", required=True, help="absolute inactive managed profile JSON")
    snapshot.add_argument("--manifest", required=True, help="absolute verified candidate manifest")
    return parser


def _run(args: argparse.Namespace) -> dict[str, Any]:
    if args.command == "install":
        return install_release(
            source_arg=args.source,
            release_root_arg=args.release_root,
            superseded_manifest_arg=args.supersedes_manifest,
            python_arg=args.python,
            dependency_seed_venv_arg=args.dependency_seed_venv,
        )
    if args.command == "doctor":
        return doctor_release(args.manifest)
    if args.command == "profile-create":
        return create_profile(
            profiles_root_arg=args.profiles_root,
            profile_id_arg=args.profile_id,
            manifest_arg=args.manifest,
            port=args.port,
            model_arg=args.model,
            provider_arg=args.provider,
            arc_manifest_arg=args.arc_manifest,
        )
    if args.command == "profile-doctor":
        return doctor_profile(args.profile, args.manifest)
    if args.command == "skills-snapshot":
        return snapshot_skills(args.profile, args.manifest)
    raise ReleaseError(f"unsupported command: {args.command}")


def main() -> int:
    try:
        result = _run(_parser().parse_args())
    except (OSError, ReleaseError) as error:
        print(json.dumps({"ok": False, "error": str(error)}, sort_keys=True), file=sys.stderr)
        return 1
    print(json.dumps(_public_result(result), indent=2, sort_keys=True))
    return 0


def _public_result(result: dict[str, Any]) -> dict[str, Any]:
    """Keep CLI output bounded; full manifests/profiles remain at reported paths."""
    return {key: value for key, value in result.items() if key not in {"manifest", "profile"}}


if __name__ == "__main__":
    raise SystemExit(main())
