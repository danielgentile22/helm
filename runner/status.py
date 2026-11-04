"""Write a routine's status file, carrying `last_success` forward.

A status file records only the latest run, so without this a failing run erases when the
routine last worked. Every routine writes through `write`, which keeps the previous
`last_success` on a failure and moves it to this run on a pass.

    python3 runner/status.py <routine> <pass|fail> <failures> [key=value ...]

Extra `key=value` pairs are stored as strings, `key=null` as null.
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

STATE = Path(os.environ.get("HELM_STATE", Path.home() / ".helm")).expanduser()


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def write(routine: str, result: str, failures: int, extra: dict | None = None,
          state: Path | None = None, now: str | None = None) -> dict:
    if result not in ("pass", "fail"):
        raise ValueError(f"result must be pass or fail, not {result!r}")
    path = (state or STATE) / "status" / f"{routine}.json"
    try:
        previous = json.loads(path.read_text()).get("last_success")
    except (OSError, ValueError, AttributeError):
        previous = None
    stamp = now or _now()
    record = {
        "routine": routine,
        "last_run": stamp,
        "result": result,
        "failures": failures,
        **(extra or {}),
        "last_success": stamp if result == "pass" else previous,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(record, indent=1) + "\n")
    tmp.replace(path)
    return record


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    routine, result, failures, *pairs = argv
    extra = {}
    for pair in pairs:
        key, sep, value = pair.partition("=")
        if not sep:
            print(f"status.py: expected key=value, got {pair!r}", file=sys.stderr)
            return 2
        extra[key] = None if value == "null" else value
    write(routine, result, int(failures), extra)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
