#!/usr/bin/env python3
"""Fixture sweep for the Claude Code token feed — compute + row shape + idempotency.

No network, no real ~/.claude scan, nothing written to the real vault: the
compute step runs against synthetic transcript records and the CSV write runs
against a tempfile. Mirrors scripts/test-router.ts (PASS/FAIL lines, nonzero
exit on any failure).

Run: python3 feeds/test_claude_tokens.py   (also wired into `npm test`)
"""
import importlib.util
import tempfile
from datetime import datetime, timezone
from pathlib import Path

# load the hyphenated feed module by path (can't `import claude-tokens`)
_spec = importlib.util.spec_from_file_location(
    "claude_tokens", Path(__file__).with_name("claude-tokens.py")
)
ct = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ct)

# fixed reference clock — no Date.now() so the sweep is deterministic
NOW = datetime(2026, 6, 17, 14, 30, 0, tzinfo=timezone.utc)
NOW_EPOCH = NOW.timestamp()
HOUR = 3600


def iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def at(hours_ago: float) -> str:
    """ISO timestamp `hours_ago` before NOW."""
    return iso(datetime.fromtimestamp(NOW_EPOCH - hours_ago * HOUR, tz=timezone.utc))


# real-shaped transcript lines (subset of the keys Claude Code actually writes).
# msg_id defaults from the uuid so simple fixtures stay one-record-per-line.
def line(uuid: str, hours_ago: float, out: int, type_: str = "assistant",
         msg_id: str | None = None) -> dict:
    return {
        "type": type_,
        "uuid": uuid,
        "timestamp": at(hours_ago),
        "message": {
            "id": msg_id or f"msg_{uuid}",
            "role": "assistant",
            "usage": {"input_tokens": 10, "output_tokens": out},
        },
    }


passed = 0
failed = 0


def check(name: str, ok: bool, got=None, want=None) -> None:
    global passed, failed
    if ok:
        passed += 1
        print(f"PASS  {name}")
    else:
        failed += 1
        print(f"FAIL  {name}\n      got:  {got!r}\n      want: {want!r}")


# --- compute: in-window sum, window boundary, future excluded ------------------
records = [
    ct.usage_record(line("a", 0.5, 100)),   # 30m ago — in
    ct.usage_record(line("b", 4.9, 200)),   # 4h54m ago — in (just inside 5h)
    ct.usage_record(line("c", 5.5, 400)),   # 5h30m ago — out
    ct.usage_record(line("d", -0.5, 800)),  # 30m in the FUTURE — out
]
check("non-assistant / missing usage parse to None",
      ct.usage_record({"type": "user", "uuid": "u"}) is None
      and ct.usage_record(line("x", 1, 5, type_="user")) is None)

val = ct.rolling_output_tokens(records, NOW_EPOCH)
check("rolling sum counts only the 5h window", val == 300, got=val, want=300)

# --- dedup: one API response = one line PER CONTENT BLOCK — different uuids,
# same message.id, identical usage payload. Keying on uuid overcounted ~3x
# (review id 52); message.id must collapse them to one count. -------------------
multiblock = ct.rolling_output_tokens(
    [
        ct.usage_record(line("u1", 0.5, 399, msg_id="msg_x")),
        ct.usage_record(line("u2", 0.5, 399, msg_id="msg_x")),
        ct.usage_record(line("u3", 0.5, 399, msg_id="msg_x")),
    ],
    NOW_EPOCH,
)
check("multi-block response (same message.id, different uuids) counted once",
      multiblock == 399, got=multiblock, want=399)

# resumed/forked sessions copy lines verbatim across files — same message.id
# AND same uuid; still exactly once, while distinct responses sum
mixed = ct.rolling_output_tokens(
    [
        ct.usage_record(line("a", 0.5, 100)),
        ct.usage_record(line("a", 0.5, 100)),  # verbatim cross-file copy
        ct.usage_record(line("b", 0.4, 50)),   # a different response
    ],
    NOW_EPOCH,
)
check("cross-file verbatim copy counted once, distinct responses sum",
      mixed == 150, got=mixed, want=150)

# --- value can legitimately be 0 (nothing in window) ---------------------------
zero = ct.rolling_output_tokens([ct.usage_record(line("z", 9, 999))], NOW_EPOCH)
check("all-stale window yields 0", zero == 0, got=zero, want=0)

# --- iter_usage_records: torn UTF-8 mid-append degrades to a skipped line, not a
# crashed run (review id 54); stale-mtime files are skipped entirely (review 53)
import json
import os

with tempfile.TemporaryDirectory() as d:
    proj = Path(d) / "projects" / "slug"
    proj.mkdir(parents=True)

    good = json.dumps(line("g", 0.5, 100))
    # torn multi-byte sequence on a line that passes the '"output_tokens"' prefilter
    (proj / "live.jsonl").write_bytes(
        good.encode() + b"\n" + b'{"output_tokens": 1, "x": "\xe2\x28"\n'
    )
    recs = list(ct.iter_usage_records(str(proj.parent)))
    check("torn UTF-8 line skipped, valid line still read",
          len(recs) == 1 and recs[0][2] == 100, got=recs, want="[('msg_g', ..., 100)]")

    (proj / "old.jsonl").write_text(json.dumps(line("o", 0.5, 500)) + "\n")
    stale = NOW_EPOCH - 10 * HOUR
    os.utime(proj / "old.jsonl", (stale, stale))
    os.utime(proj / "live.jsonl", (NOW_EPOCH, NOW_EPOCH))
    recs = list(ct.iter_usage_records(str(proj.parent), min_mtime=NOW_EPOCH - 6 * HOUR))
    check("stale-mtime file skipped by the recency prefilter",
          len(recs) == 1 and recs[0][2] == 100, got=recs, want="only live.jsonl's record")

# --- row shape + idempotency against a tempfile --------------------------------
with tempfile.TemporaryDirectory() as d:
    csv = Path(d) / "system" / "metrics" / "metrics.csv"
    ts = ct.hour_bucket(NOW)  # 2026-06-17T14:00:00Z

    wrote1 = ct.append_metric_row(csv, ts, ct.SOURCE, ct.METRIC, 300)
    wrote2 = ct.append_metric_row(csv, ts, ct.SOURCE, ct.METRIC, 300)  # same hour → no-op

    body = csv.read_text().splitlines()
    data = [ln for ln in body[1:] if ln.strip()]

    check("first write appends, second is idempotent no-op",
          wrote1 is True and wrote2 is False, got=(wrote1, wrote2), want=(True, False))
    check("header is the frozen contract",
          body[0] == "timestamp,source,metric,value,status,error", got=body[0])
    check("exactly one data row after re-run", len(data) == 1, got=len(data), want=1)

    cols = data[0].split(",") if data else []
    check("row is well-formed: 6 cols, right values",
          cols == [ts, "claude_code", "tokens_5h", "300", "ok", ""],
          got=cols, want=[ts, "claude_code", "tokens_5h", "300", "ok", ""])

    # a different hour bucket DOES append (idempotency is per-window, not forever)
    ts_next = ct.hour_bucket(datetime(2026, 6, 17, 15, 5, 0, tzinfo=timezone.utc))
    wrote3 = ct.append_metric_row(csv, ts_next, ct.SOURCE, ct.METRIC, 350)
    data2 = [ln for ln in csv.read_text().splitlines()[1:] if ln.strip()]
    check("new hour bucket appends a fresh row",
          wrote3 is True and len(data2) == 2, got=(wrote3, len(data2)), want=(True, 2))

total = passed + failed
print(f"\nAll {total} cases pass." if failed == 0 else f"\n{failed}/{total} FAILED")
raise SystemExit(1 if failed else 0)
