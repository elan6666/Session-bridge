#!/usr/bin/env python3
"""Atomically hand the byte-relay baton between exact harness sessions."""

import argparse
import datetime as dt
import json
import os
import sys
from pathlib import Path


HARNESS_CHOICES = ("codex", "claude", "dsh", "zcode")


def now_iso():
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")


def load_json(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise RuntimeError(f"required relay file not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"invalid JSON in {path}: {exc}") from exc


def atomic_write(path, value):
    tmp = path.with_name(path.name + ".tmp")
    payload = json.dumps(value, ensure_ascii=False, indent=2) + "\n"
    try:
        with open(tmp, "w", encoding="utf-8") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, path)
    finally:
        try:
            tmp.unlink()
        except FileNotFoundError:
            pass


def session_ref(value):
    harness, separator, native_id = value.partition(":")
    if separator != ":" or harness not in HARNESS_CHOICES or not native_id:
        raise RuntimeError(
            "session reference must be <codex|claude|dsh|zcode>:<native-session-id>"
        )
    return harness, native_id


def require_handoff(project, value):
    coordination = project / ".byte-os" / "coordination"
    handoff_root = (coordination / "handoffs").resolve()
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = project / path
    path = path.resolve()
    try:
        relative = path.relative_to(handoff_root)
    except ValueError as exc:
        raise RuntimeError(f"handoff must be inside {handoff_root}") from exc
    if not path.is_file():
        raise RuntimeError(f"handoff file not found: {path}")
    return str(Path(".byte-os") / "coordination" / "handoffs" / relative)


def handoff(args):
    project = Path(args.project).expanduser().resolve()
    state_path = project / ".byte-os" / "coordination" / "state.json"
    state = load_json(state_path)
    from_key = f"{args.from_harness}:{args.from_session_id}"
    session_ref(from_key)
    if state.get("owner") != args.from_harness:
        raise RuntimeError(
            f"authority mismatch: state.owner={state.get('owner')!r}, "
            f"requested harness={args.from_harness!r}"
        )
    registry_path = project / ".byte-os" / "coordination" / "sessions.json"
    registry = load_json(registry_path) if registry_path.exists() else None
    exact_owner = state.get("owner_session")
    if exact_owner is not None and exact_owner != from_key:
        raise RuntimeError(
            f"session authority mismatch: state.owner_session={exact_owner!r}, "
            f"requested session={from_key!r}"
        )
    if exact_owner is None and registry is not None:
        active = registry.get("active_by_harness", {}).get(args.from_harness)
        if active is not None and active != from_key:
            raise RuntimeError(
                f"legacy session authority mismatch: active session={active!r}, "
                f"requested session={from_key!r}"
            )
    if args.from_stage is not None and state.get("stage") != args.from_stage:
        raise RuntimeError(
            f"stage mismatch: state.stage={state.get('stage')!r}, "
            f"requested stage={args.from_stage!r}"
        )

    to_harness, _ = session_ref(args.to_session)
    handoff_path = require_handoff(project, args.handoff)
    previous_stage = state.get("stage")
    timestamp = now_iso()
    participants = state.setdefault("participants", {})
    from_participant = participants.setdefault(
        from_key,
        {
            "harness": args.from_harness,
            "role": state.get("roles", {}).get(args.from_harness),
        },
    )
    to_participant = participants.setdefault(
        args.to_session,
        {
            "harness": to_harness,
            "role": args.to_role or state.get("roles", {}).get(to_harness),
        },
    )
    if args.from_role:
        from_participant["role"] = args.from_role
    if args.to_role:
        to_participant["role"] = args.to_role
    registered_target = (
        registry.get("sessions", {}).get(args.to_session, {}) if registry is not None else {}
    )
    target_host_id = args.to_host_id or to_participant.get("host_id") or registered_target.get("host_id")
    if to_harness == "codex" and not target_host_id:
        raise RuntimeError(
            "Codex target requires --to-host-id or a registered session with host_id"
        )
    if target_host_id:
        to_participant["host_id"] = target_host_id
    if args.reports_to:
        session_ref(args.reports_to)
        to_participant["reports_to"] = args.reports_to

    state.setdefault("history", []).append(
        {
            "ts": timestamp,
            "from": args.from_harness,
            "to": to_harness,
            "from_session": from_key,
            "to_session": args.to_session,
            "from_stage": previous_stage,
            "to_stage": args.to_stage,
            "handoff": handoff_path,
            "note": args.note,
        }
    )
    state["owner"] = to_harness
    state["owner_session"] = args.to_session
    state["stage"] = args.to_stage
    state["next_action"] = args.next_action
    if args.acceptance is not None:
        state["acceptance"] = args.acceptance
    state["updated_at"] = timestamp
    atomic_write(state_path, state)
    print(json.dumps(state, ensure_ascii=False, indent=2))


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    handoff_parser = sub.add_parser("handoff", help="move the baton after writing a handoff")
    handoff_parser.add_argument("--project", required=True)
    handoff_parser.add_argument("--from-harness", required=True, choices=HARNESS_CHOICES)
    handoff_parser.add_argument("--from-session-id", required=True)
    handoff_parser.add_argument("--from-stage")
    handoff_parser.add_argument("--from-role")
    handoff_parser.add_argument("--to-session", required=True)
    handoff_parser.add_argument("--to-stage", required=True)
    handoff_parser.add_argument("--to-role")
    handoff_parser.add_argument("--to-host-id")
    handoff_parser.add_argument("--reports-to")
    handoff_parser.add_argument("--next-action", required=True)
    handoff_parser.add_argument("--acceptance")
    handoff_parser.add_argument("--handoff", required=True)
    handoff_parser.add_argument("--note", required=True)
    handoff_parser.set_defaults(func=handoff)
    return parser


def main():
    args = build_parser().parse_args()
    try:
        args.func(args)
    except RuntimeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
