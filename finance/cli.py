import argparse
import json

from finance.board import write_board
from finance.config import ROOT, database_path, snapshot_path
from finance.pipeline import check_sources, collect
from finance.snapshot import write_snapshot
from finance.storage.db import Store
from finance.validation.checks import validate_stored


def main(argv=None):
    _load_env(ROOT / ".env")
    parser = argparse.ArgumentParser(prog="python -m finance")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("check")
    backfill = sub.add_parser("backfill")
    backfill.add_argument("--since")
    sub.add_parser("update")
    sub.add_parser("validate")
    sub.add_parser("snapshot")
    args = parser.parse_args(argv)
    store = Store(database_path())
    try:
        if args.command == "check":
            lines, public_ok = check_sources(store)
            print(json.dumps(lines, ensure_ascii=False, indent=2))
            return 0 if public_ok else 1
        if args.command in ("update", "backfill"):
            totals = collect(store, args.command, getattr(args, "since", None))
            print(json.dumps(totals, ensure_ascii=False))
            return 0
        if args.command == "validate":
            issues = validate_stored(store)
            print(json.dumps(issues, ensure_ascii=False, indent=2))
            return 1 if any(issue["severity"] == "error" for issue in issues) else 0
        payload = write_snapshot(store, snapshot_path())
        board = write_board(store, ROOT / "runtime" / "finance-board.json")
        print(str(snapshot_path()))
        print(json.dumps({"instruments": len(payload["instruments"]), "heroes": len(board["heroes"])}, ensure_ascii=False))
        return 0
    finally:
        store.close()


def _load_env(path):
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        text = line.strip()
        if not text or text.startswith("#") or "=" not in text:
            continue
        name, value = text.split("=", 1)
        name = name.strip()
        if name and name not in __import__("os").environ:
            __import__("os").environ[name] = value.strip().strip('"').strip("'")
