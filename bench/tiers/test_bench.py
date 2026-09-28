"""The harness's own logic, with no server and no `claude`: the ladder arithmetic, the menu
check, the stream-json reader, the grader, the fixture's contract and the temp dir guard."""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import bench  # noqa: E402

DEMO = bench.ENGINE / "demo-vault"


def run(**kw) -> bench.Run:
    base = dict(ms=10, said="", tools=(), denied=0, timed_out=False, subtype="success", commits=0, changed=())
    return bench.Run(**{**base, **kw})


def case(**kw) -> bench.Case:
    base = dict(n=1, say="x", tier=2, action=None, ambiguous=False, answer_has=(), diff_has=(), dept=None)
    return bench.Case(**{**base, **kw})


READ = case(answer_has=("priya",))
EDIT = case(diff_has=("aisle seat",), dept="Life")


class Ladder(unittest.TestCase):
    def test_confident_decision_stands(self):
        self.assertEqual(bench.effective(2, 0.9, 0.5), 2)

    def test_escalation_is_capped_at_cloud(self):
        self.assertEqual(bench.effective(3, 0.1, 0.5), 3)

    def test_a_doubtful_none_climbs_past_instant_to_local(self):
        self.assertEqual(bench.effective(0, 0.1, 0.5), 2)
        self.assertEqual(bench.effective(1, 0.1, 0.5), 2)

    def test_noise_is_unsafe_only_as_an_instant_action(self):
        self.assertTrue(bench.unsafe(0, 1))
        self.assertFalse(bench.unsafe(0, 0))
        self.assertFalse(bench.unsafe(0, 2))
        self.assertFalse(bench.unsafe(0, 3))

    def test_below_the_label_is_unsafe(self):
        self.assertTrue(bench.unsafe(3, 2))
        self.assertFalse(bench.unsafe(2, 3))
        self.assertFalse(bench.unsafe(1, 1))

    def test_picks_the_lowest_safe_threshold(self):
        points = [bench.Point(1, 2, 1, 0.42), bench.Point(2, 1, 1, 0.9), bench.Point(3, 3, 3, 0.2)]
        self.assertEqual(bench.pick_threshold(points), 0.45)

    def test_reports_none_when_unsafe_at_one(self):
        points = [bench.Point(1, 3, 1, 1.0), bench.Point(2, 1, 1, 0.9)]
        self.assertIsNone(bench.pick_threshold(points))
        self.assertEqual(bench.unsafe_at(points, 1.0), [1])

    def test_unknown_tier_key_reads_as_cloud(self):
        d = bench.Decision("", {}, 0.0, "", {}, 0.0, 5)
        self.assertEqual(bench.decided_tier(d), 3)

    def test_instant_without_a_menu_action_reads_as_local(self):
        for action in ("", "none"):
            d = bench.Decision("instant", {}, 0.9, action, {}, 0.5, 5)
            self.assertEqual(bench.decided_tier(d), 2)
        self.assertEqual(bench.decided_tier(bench.Decision("instant", {}, 0.9, "agenda", {}, 0.5, 5)), 1)


class Menu(unittest.TestCase):
    def test_a_key_outside_the_menu_is_rejected(self):
        menu = bench.build_menu(DEMO)
        body = {"answers": {"tier": {"choice": "instant", "confidence": 0.8, "probabilities": {"instant": 0.8}},
                            "action": {"choice": "note:Nowhere", "confidence": 0.9, "probabilities": {}}}}
        with mock.patch.object(bench, "ask_kev", return_value=body):
            d = bench.decide("open the Nowhere note", menu)
        self.assertEqual(d.action, "")
        self.assertEqual(d.tier, "instant")
        cell = bench.Cell("4b", "qwen", decisions={1: d})
        self.assertEqual(bench.summarize(cell, [case(tier=1, action="note:Compiler")])["rejected"], 1)

    def test_menu_holds_every_atlas_note(self):
        menu = bench.build_menu(DEMO)
        self.assertIn("note:Team Wiki", menu)
        self.assertIn("note:2026-09-20-star-the-launch", menu)
        self.assertIn("none", menu)


class Stream(unittest.TestCase):
    def test_transcript_becomes_a_run(self):
        lines = [
            {"type": "system", "subtype": "init"},
            {"type": "assistant", "message": {"content": [{"type": "text", "text": "looking"},
                                                          {"type": "tool_use", "name": "Grep", "input": {}}]}},
            {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Bash", "input": {}}]}},
            "this line is not json {",
            {"type": "user", "message": {"content": [{"type": "tool_result", "is_error": True,
                                                      "content": "Claude requested permissions to use Bash, but you haven't granted it yet."}]}},
            {"type": "user", "message": {"content": [{"type": "tool_result", "is_error": True, "content": [
                {"type": "text", "text": "File does not exist."}]}]}},
            {"type": "result", "subtype": "success", "result": "Priya runs product.", "duration_ms": 900, "num_turns": 3},
        ]
        stdout = "\n".join(line if isinstance(line, str) else json.dumps(line) for line in lines)
        r = bench.parse_stream(stdout, ms=1200, timed_out=False)
        self.assertEqual(r.tools, ("Grep", "Bash"))
        self.assertEqual(r.denied, 1)
        self.assertEqual(r.said, "Priya runs product.")
        self.assertEqual(r.subtype, "success")
        self.assertEqual(r.ms, 1200)

    def test_an_event_whose_message_is_a_string_is_skipped(self):
        lines = [{"type": "error", "message": "rate limited"},
                 {"type": "result", "subtype": "success", "result": "ok"}]
        r = bench.parse_stream("\n".join(json.dumps(l) for l in lines), ms=1, timed_out=False)
        self.assertEqual((r.said, r.tools), ("ok", ()))

    def test_no_result_event_leaves_subtype_empty(self):
        r = bench.parse_stream("garbage\n", ms=1, timed_out=True)
        self.assertEqual((r.subtype, r.said, r.timed_out), ("", "", True))


class Argv(unittest.TestCase):
    def test_sandbox_comes_from_turns(self):
        turns = SimpleNamespace(CLAUDE_BIN="claude-x", PERMISSION_MODE="pm", ALLOWED_TOOLS="allow", DISALLOWED_TOOLS="deny")
        argv = bench.tier2_argv(turns, "p", "qwen")
        self.assertEqual(argv[0], "claude-x")
        for flag, value in (("--permission-mode", "pm"), ("--allowedTools", "allow"),
                            ("--disallowedTools", "deny"), ("--model", bench.LOCAL["qwen"])):
            self.assertEqual(argv[argv.index(flag) + 1], value)
        self.assertNotIn("--effort", argv)

    def test_env_points_at_ollama_without_the_api_key(self):
        with mock.patch.dict("os.environ", {"ANTHROPIC_API_KEY": "k"}):
            env = bench.tier2_env("gemma", Path("/tmp/s"))
        self.assertNotIn("ANTHROPIC_API_KEY", env)
        self.assertEqual(env["ANTHROPIC_BASE_URL"], bench.OLLAMA_URL)
        self.assertEqual(env["ANTHROPIC_DEFAULT_OPUS_MODEL"], bench.LOCAL["gemma"])


class Grading(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root, cls.vault, cls.base = bench.copy_vault()

    @classmethod
    def tearDownClass(cls):
        subprocess.run(["rm", "-rf", str(cls.root)], check=True)

    def setUp(self):
        bench.restore(self.vault, self.base)

    def commit(self, rel: str, old: str, new: str) -> None:
        path = self.vault / rel
        path.write_text(path.read_text().replace(old, new))
        bench.git(self.vault, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qam", "edit")

    def edit_run(self, **kw) -> tuple[bench.Run, str]:
        commits, changed, diff = bench.vault_facts(self.vault, self.base)
        return run(commits=commits, changed=changed, **kw), diff

    def test_passing_edit(self):
        self.commit("Atlas/Life/Life.md", "(due: 2026-10-05)\n", "(due: 2026-10-05)\n  Sam wants the aisle seat.\n")
        r, diff = self.edit_run(tools=("Bash",))
        self.assertEqual(r.changed, ("Atlas/Life/Life.md",))
        self.assertEqual(bench.grade(EDIT, r, diff), "pass")

    def test_edit_in_the_wrong_note(self):
        self.commit("Atlas/Work/Work.md", "one screen.", "one screen. Sam wants the aisle seat.")
        r, diff = self.edit_run()
        self.assertEqual(bench.grade(EDIT, r, diff), "wrong_edit")

    def test_context_line_does_not_pass_an_edit(self):
        self.commit("Atlas/Life/Life.md", "Order the desk lamp", "Order the desk lamp soon")
        r, diff = self.edit_run()
        self.assertEqual(bench.grade(case(diff_has=("book the winter tire swap",), dept="Life"), r, diff), "wrong_edit")

    def test_no_commit_is_gave_up(self):
        r, diff = self.edit_run(said="I could not.")
        self.assertEqual(bench.grade(EDIT, r, diff), "gave_up")

    def test_write_on_a_read(self):
        self.commit("Atlas/Life/Life.md", "Order the desk lamp", "Order the desk lamp now")
        r, diff = self.edit_run(said="Priya runs product.")
        self.assertEqual(bench.grade(READ, r, diff), "wrote_when_read")

    def test_passing_read(self):
        self.assertEqual(bench.grade(READ, run(said="Priya runs product on Compiler."), ""), "pass")

    def test_wrong_answer(self):
        self.assertEqual(bench.grade(READ, run(said="Alex runs it."), ""), "wrong_answer")

    def test_empty_reply_is_gave_up(self):
        self.assertEqual(bench.grade(READ, run(said="", subtype="error_max_turns"), ""), "gave_up")

    def test_timeout_first(self):
        self.assertEqual(bench.grade(READ, run(timed_out=True, tools=("Frobnicate",)), ""), "timeout")

    def test_invented_tool(self):
        self.assertEqual(bench.grade(READ, run(tools=("Read", "TodoWrite"), said="Priya"), ""), "invented_tool")

    def test_denied_and_unmet_is_malformed(self):
        self.assertEqual(bench.grade(READ, run(tools=("Bash",), denied=1, said="unsure"), ""), "malformed_tool")

    def test_denied_but_met_passes(self):
        self.assertEqual(bench.grade(READ, run(tools=("Bash",), denied=1, said="Priya"), ""), "pass")


class Fixture(unittest.TestCase):
    def test_every_case_keeps_the_contract(self):
        cases = bench.load_cases()
        menu = bench.build_menu(DEMO)
        self.assertGreaterEqual(len(cases), 30)
        for c in cases:
            self.assertIn(c.tier, (0, 1, 2, 3), c.say)
            if c.tier == 1:
                self.assertIn(c.action, menu, c.say)
            if c.tier == 2:
                self.assertTrue(bool(c.answer_has) != bool(c.diff_has and c.dept), c.say)
            if c.action and c.action.startswith("note:"):
                title = c.action.removeprefix("note:")
                self.assertTrue(any(p.stem == title for p in (DEMO / "Atlas").rglob("*.md")), c.action)
            if c.dept:
                self.assertTrue((DEMO / bench.dept_note(c.dept)).is_file(), c.dept)

    def test_loader_refuses_a_broken_case(self):
        with tempfile.TemporaryDirectory() as d:
            bad = Path(d) / "f.json"
            bad.write_text(json.dumps({"cases": [{"say": "x", "tier": 2}]}))
            with self.assertRaises(ValueError):
                bench.load_cases(bad)


class Guard(unittest.TestCase):
    def test_refuses_outside_the_temp_dir(self):
        with self.assertRaises(SystemExit):
            bench.ensure_temporary(DEMO)

    def test_accepts_a_temp_copy(self):
        with tempfile.TemporaryDirectory() as d:
            bench.ensure_temporary(Path(d) / "Vault")


class Memory(unittest.TestCase):
    def test_footprint_units(self):
        self.assertEqual(bench.parse_footprint("zsh [1]: 64-bit    Footprint: 2048 KB (16384 bytes per page)"), 2)
        self.assertEqual(bench.parse_footprint("python [2]: 64-bit    Footprint: 17.5 GB"), 17920)
        self.assertEqual(bench.parse_footprint("nothing"), 0)

    def test_tree_includes_descendants(self):
        rows = [bench.Proc(10, 1, 30, "uv run"), bench.Proc(11, 10, 9000, "python -m kev.serve"),
                bench.Proc(12, 11, 1, "helper"), bench.Proc(20, 1, 5, "other")]
        self.assertEqual(bench.tree(rows, {10}), {10, 11, 12})

    def test_process_memory_is_the_larger_of_rss_and_footprint(self):
        with mock.patch.object(bench, "footprint_mb", return_value=2242):
            self.assertEqual(bench.process_mb(bench.Proc(1, 0, 22887, "llama-server")), 22887)
        with mock.patch.object(bench, "footprint_mb", return_value=9300):
            self.assertEqual(bench.process_mb(bench.Proc(2, 0, 5578, "python -m kev.serve")), 9300)

    def test_swap_used(self):
        self.assertEqual(bench.swap_used_mb("total = 2048.00M  used = 1234.50M  free = 813.50M"), 1234)
        self.assertEqual(bench.swap_used_mb("total = 4.00G  used = 1.50G  free = 2.50G"), 1536)


class Results(unittest.TestCase):
    def cell(self, kev: str, local: str, conf: float, warm: int, passes: int) -> bench.Cell:
        cases = bench.load_cases()
        c = bench.Cell(kev, local, latency=bench.Latency(9000, 4000, warm, 40.0))
        for k in cases:
            c.decisions[k.n] = bench.Decision(bench.TIER_KEY[k.tier], {}, conf, k.action or "none", {}, conf, 50 + k.n)
        for k in (k for k in cases if k.tier == 2):
            c.grades[k.n] = "pass" if passes > 0 else "gave_up"
            passes -= 1
        c.samples = [bench.Sample(0.0, {"kev": 5000, "ollama": 20000, "voice": 900}, 40, 0)]
        return c

    def test_render_and_recommend(self):
        cases = bench.load_cases()
        cells = [self.cell("4b", "qwen", 0.9, 3000, 10), self.cell("4b", "gemma", 0.9, 2000, 12),
                 self.cell("9b", "qwen", 0.95, 3000, 10), self.cell("9b", "gemma", 0.95, 2000, 12)]
        summaries = [bench.summarize(c, cases) for c in cells]
        best = bench.recommend(summaries)
        self.assertEqual((best["kev"], best["local"]), ("4b", "gemma"))
        meta = {"date": "2026-09-28 10:00", "hw_model": "Mac", "memsize_gb": 64, "macos": "27.0",
                "claude": "2.1", "ollama": "0.20", "kev_commit": "abc"}
        md = bench.render_md(meta, cases, cells, summaries)
        self.assertIn("Recommendation: Kev 4b (jaredpalmer/kev-4b) with gemma4:26b, threshold 0.00.", md)
        self.assertIn("| 4b | gemma | 4.9/19.5/0.9 |", md)
        json.dumps({"cells": [bench.asdict(c) for c in cells], "summaries": summaries}, default=str)

    def test_a_kev_with_a_safe_threshold_beats_one_without(self):
        cases = bench.load_cases()
        small = self.cell("4b", "qwen", 0.9, 3000, 10)
        big = self.cell("9b", "qwen", 0.9, 3000, 10)
        noise = next(k.n for k in cases if k.tier == 0)
        big.decisions[noise] = bench.Decision("instant", {}, 1.0, "agenda", {}, 1.0, 50)
        summaries = [bench.summarize(c, cases) for c in (small, big)]
        self.assertIsNone(summaries[1]["threshold"])
        self.assertEqual(bench.recommend(summaries)["kev"], "4b")

    def test_report_renders_again_from_the_results_file(self):
        cases = bench.load_cases()
        cells = [self.cell("4b", "gemma", 0.9, 2000, 12)]
        summaries = [bench.summarize(c, cases) for c in cells]
        meta = {"date": "2026-09-28 10:00", "hw_model": "Mac", "memsize_gb": 64, "macos": "27.0",
                "claude": "2.1", "ollama": "0.20", "kev_commit": "abc"}
        with tempfile.TemporaryDirectory() as tmp:
            js = Path(tmp) / "r.json"
            js.write_text(json.dumps({"meta": meta, "cases": [bench.asdict(c) for c in cases],
                                      "cells": [{**bench.asdict(c), "samples": None} for c in cells],
                                      "summaries": summaries}, default=str))
            md = bench.rerender(js)
            self.assertEqual(md.read_text(), bench.render_md(meta, cases, cells, summaries))

    def test_blocked_cell_renders(self):
        cases = bench.load_cases()
        c = self.cell("9b", "qwen", 0.3, 3000, 0)
        c.grades, c.tier2_blocked, c.stderr_tail = {}, "no result event, exit 1", "boom"
        md = bench.render_md({"date": "d", "hw_model": "m", "memsize_gb": 1, "macos": "x", "claude": "c",
                              "ollama": "o", "kev_commit": "k"}, cases, [c], [bench.summarize(c, cases)])
        self.assertIn("tier 2 blocked, no result event, exit 1", md)
        self.assertIn("| blocked |", md)


if __name__ == "__main__":
    unittest.main()
