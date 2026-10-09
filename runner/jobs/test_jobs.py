"""The job search pipeline, every stage pure and against fictional data: parsing saved
LinkedIn markup, the screen, the ranker's answer, the note and the report, and the
orchestrator's bookkeeping with the network and the model faked.

    python3 -m unittest discover -s runner/jobs -p 'test_*.py'
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
import urllib.parse
from datetime import date
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import claude  # noqa: E402
import linkedin  # noqa: E402
import passes  # noqa: E402
import pool as poolmod  # noqa: E402
import rank  # noqa: E402
import report  # noqa: E402
import screen  # noqa: E402
import tailor  # noqa: E402
from model import Cost, Criteria, Dropped, Eligibility, Pick, Posting, Query, SkillMark, Skills, Usage, criteria_hash  # noqa: E402

DEMO = HERE.parents[1] / "demo-vault"
TODAY = date(2026, 10, 8)

CARDS = """
<li><div class="base-card" data-entity-urn="urn:li:jobPosting:1001" data-tracking-id="x">
<h3 class="base-search-card__title">
        Junior Backend Engineer
      </h3>
<h4 class="base-search-card__subtitle"><a class="hidden-nested-link" href="https://pt.linkedin.com/company/keel">
        Keel &amp; Co
      </a></h4>
<span class="job-search-card__location">Lisbon, Portugal</span>
<time class="job-search-card__listdate" datetime="2026-10-06">6 days ago</time>
</div></li>
<li><div class="base-card" data-entity-urn="urn:li:jobPosting:1002">
<h3 class="base-search-card__title">Senior Staff Engineer</h3>
<h4 class="base-search-card__subtitle">Compiler Labs</h4>
<span class="job-search-card__location">Remote</span>
<time datetime="2026-09-30">1 week ago</time>
</div></li>
"""

POSTING = """
<div class="show-more-less-html__markup description__text">
<p>Keel builds <strong>routing software</strong> for small fleets.</p>
<ul><li>1+ years of Python</li><li>FastAPI, Postgres</li></ul>
</div>
<div class="other">
<h3 class="description__job-criteria-subheader">Seniority level</h3>
<span class="description__job-criteria-text">Entry level</span>
<h3 class="description__job-criteria-subheader">Employment type</h3>
<span class="description__job-criteria-text">Full-time</span>
<span class="num-applicants__caption">42 applicants</span>
<button class="apply-button--easy">Easy Apply</button>
"""


def criteria(**over) -> Criteria:
    c = Criteria.load(DEMO / "Atlas/Work/files/job-search/criteria.json")
    return Criteria(**{**c.__dict__, **over})


def posting(pid="1001", title="Junior Backend Engineer", company="Keel", desc="Python and FastAPI.",
            applicants="42 applicants", posted="2026-10-06") -> Posting:
    return Posting(id=pid, title=title, company=company, location="Lisbon, Portugal", posted=posted,
                   query="software engineer python", description=desc, applicants=applicants)


class ClaudeRuns(unittest.TestCase):
    RESULT = {"type": "result", "is_error": False, "result": "{\"picks\": []}", "total_cost_usd": 0.0421,
              "usage": {"input_tokens": 1200, "output_tokens": 80, "cache_creation_input_tokens": 300,
                        "cache_read_input_tokens": 4000}}

    def capture(self, stdout: str):
        calls = []

        def fake(argv, cwd, env, input, capture_output, text, timeout):
            calls.append((argv, input))
            return mock.Mock(stdout=stdout, stderr="", returncode=0)
        return calls, fake

    def test_prompt_goes_on_stdin_and_the_result_text_and_usage_come_back(self):
        calls, fake = self.capture(json.dumps(self.RESULT))
        with mock.patch.object(claude.subprocess, "run", fake):
            out = claude.run("rank these", "opus", "high", Path("/tmp"), 5, read_only=True)
        argv, stdin = calls[0]
        self.assertEqual(stdin, "rank these")
        self.assertNotIn("rank these", argv)
        self.assertEqual(argv[argv.index("--output-format") + 1], "json")
        self.assertIn("--allowedTools", argv)
        self.assertEqual(out.stdout, '{"picks": []}')
        self.assertEqual(out.usage, Usage(1200, 80, 4000, 300, 0.0421))
        self.assertTrue(out.ok)
        self.assertIn('"total_cost_usd"', out.raw)

    def test_stream_mode_keeps_the_events_and_reads_the_last_result(self):
        lines = "\n".join([json.dumps({"type": "system"}), json.dumps({"type": "assistant", "x": 1}),
                           json.dumps(self.RESULT)])
        calls, fake = self.capture(lines)
        with mock.patch.object(claude.subprocess, "run", fake):
            out = claude.run("tailor", "opus", "high", Path("/tmp"), 5, stream=True)
        self.assertEqual(calls[0][0][calls[0][0].index("--output-format") + 1], "stream-json")
        self.assertEqual(out.stdout, lines)
        self.assertEqual(out.usage.input_tokens, 1200)

    def test_output_that_is_not_json_passes_through_with_zero_usage(self):
        calls, fake = self.capture("plain text")
        with mock.patch.object(claude.subprocess, "run", fake):
            out = claude.run("x", "opus", "high", Path("/tmp"), 5)
        self.assertEqual((out.stdout, out.usage), ("plain text", Usage()))

    def test_usage_sums_and_a_cost_round_trips(self):
        total = Usage(1, 2, 3, 4, 0.5) + Usage(10, 20, 30, 40, 0.25)
        self.assertEqual(total, Usage(11, 22, 33, 44, 0.75))
        c = Cost()
        c.add(Usage(1, 2, 3, 4, 0.5))
        c.cached += 2
        self.assertEqual(Cost.from_dict(json.loads(json.dumps(c.to_dict()))), c)

    def test_registry_rejects_what_the_policy_forbids(self):
        data = {"policy": {"forbidden_models": ["haiku"], "forbidden_effort": ["xhigh", "max"]},
                "routines": {"job-search": {"model": "opus", "effort": "high",
                                            "passes": {"eligibility": {"model": "haiku", "effort": "low"},
                                                       "skills": {"model": "sonnet", "effort": "max"},
                                                       "fine": {"model": "sonnet", "effort": "medium"}}}}}
        with mock.patch.object(claude, "_models", lambda: data):
            self.assertEqual(claude.registry("routines", "job-search"), ("opus", "high"))
            self.assertEqual(claude.pass_registry("job-search", "fine"), ("sonnet", "medium"))
            with self.assertRaises(ValueError):
                claude.pass_registry("job-search", "eligibility")
            with self.assertRaises(ValueError):
                claude.pass_registry("job-search", "skills")


class Parsing(unittest.TestCase):
    def test_cards_carry_id_title_company_location_and_date(self):
        q = Query("software engineer python", "Lisbon, Portugal")
        cards = linkedin.parse_cards(CARDS, q)
        self.assertEqual([c.id for c in cards], ["1001", "1002"])
        self.assertEqual(cards[0].title, "Junior Backend Engineer")
        self.assertEqual(cards[0].company, "Keel & Co")
        self.assertEqual(cards[0].location, "Lisbon, Portugal")
        self.assertEqual(cards[0].posted, "2026-10-06")
        self.assertEqual(cards[1].company, "Compiler Labs")
        self.assertEqual(cards[0].url, "https://www.linkedin.com/jobs/view/1001/")

    def test_posting_page_fills_description_criteria_applicants_and_easy_apply(self):
        p = linkedin.parse_posting(POSTING, posting(desc=""))
        self.assertIn("routing software for small fleets", p.description)
        self.assertIn("1+ years of Python", p.description)
        self.assertEqual(p.seniority, "Entry level")
        self.assertEqual(p.employment, "Full-time")
        self.assertEqual(p.applicants, "42 applicants")
        self.assertTrue(p.easy_apply)

    def test_throttled_page_raises(self):
        with self.assertRaises(ValueError):
            linkedin.parse_posting("<html>sign in</html>", posting())

    def test_search_url_names_experience_window_and_remote(self):
        url = linkedin.search_url(Query("ai engineer", "European Union", remote=True), ("2",), 14, 25,
                                  ("F", "C"), ("eng", "it"))
        self.assertIn("f_E=2", url)
        self.assertIn("f_TPR=r1209600", url)
        self.assertIn("f_WT=2", url)
        self.assertIn("start=25", url)
        self.assertIn("f_JT=F%2CC", url)
        self.assertIn("f_F=eng%2Cit", url)
        plain = linkedin.search_url(Query("x", "y"), ("2",), 14, 0)
        for key in ("f_WT", "f_JT", "f_F"):
            self.assertNotIn(key, plain)

    def test_search_stops_once_it_has_seen_enough_new_cards(self):
        pages = []

        def fake_fetch(url):
            start = int(urllib.parse.parse_qs(urllib.parse.urlparse(url).query)["start"][0])
            pages.append(start)
            return "" if start >= 30 else CARDS.replace("1001", str(start + 1)).replace("1002", str(start + 2))
        q = Query("x", "y")
        with mock.patch.object(linkedin, "fetch", fake_fetch), mock.patch.object(linkedin.time, "sleep", lambda s: None):
            found = linkedin.search(q, criteria(pages=5), known={"1", "2"}, want=2)
            self.assertEqual(pages, [0, 10])
            self.assertEqual([p.id for p in found], ["1", "2", "11", "12"])
            pages.clear()
            found = linkedin.search(q, criteria(pages=5), known=set(), want=50)
            self.assertEqual(pages, [0, 10, 20, 30])


class Screen(unittest.TestCase):
    def test_title_deny_is_a_regex_on_the_title(self):
        c = criteria()
        self.assertIsNone(screen.title_reason(posting(), c))
        self.assertIn("senior", screen.title_reason(posting(title="Senior Backend Engineer"), c))
        self.assertIsNone(screen.title_reason(posting(title="Seniority is not a word here"), c))

    def test_company_deny_is_a_regex_on_the_company(self):
        c = criteria(company_deny=(r"\bjobright\b",))
        self.assertIsNone(screen.title_reason(posting(), c))
        self.assertIn("jobright", screen.title_reason(posting(company="Jobright.ai"), c))

    def test_min_years_reads_the_low_end_of_a_range(self):
        self.assertEqual(screen.min_years("3-5 years of experience"), 3)
        self.assertEqual(screen.min_years("2 to 4 yrs of Python"), 2)
        self.assertEqual(screen.min_years("1+ years in a backend role"), 1)
        self.assertEqual(screen.min_years("5+ years with Java, or 2 years with Python"), 2)
        self.assertIsNone(screen.min_years("a strong engineer"))
        self.assertIsNone(screen.min_years("a company with 80 years of history; must be 18 years of age"))
        self.assertEqual(screen.min_years("Founded 75 years ago. 3+ years' hands-on Python."), 3)
        self.assertIsNone(screen.min_years("Bachelor's in CS, or in lieu of a degree an additional 4 years of relevant work experience."))

    def test_description_deny_and_years_floor(self):
        c = criteria(max_years=2)
        self.assertIsNone(screen.description_reason(posting(), c))
        self.assertIn("citizenship", screen.description_reason(
            posting(desc="US citizenship is required for this role."), c).lower())
        self.assertEqual(screen.description_reason(posting(desc="Requires 4+ years of Python."), c), "asks 4 years")

    def test_a_posting_away_from_home_must_say_remote_and_never_hybrid(self):
        c = criteria(home_location=r",\s*(VA|DC|MD)$", remote_says=(r"\bremote\b",),
                     remote_denies=(r"\bhybrid\b",))
        home = posting(desc="Hybrid, three days in Reston.")
        home.location = "Reston, VA"
        self.assertIsNone(screen.description_reason(home, c))
        self.assertIn("nothing saying", screen.description_reason(posting(desc="Python in Hartford."), c))
        self.assertIn("hybrid", screen.description_reason(posting(desc="Remote-friendly, but this is a hybrid role."), c))
        self.assertIsNone(screen.description_reason(posting(desc="Fully remote. See https://x.com/Hybrid-Mesh"), c))

    def test_shortlist_prefers_keyword_hits_then_few_applicants_then_recency(self):
        c = criteria(shortlist=2)
        a = posting("1", desc="python fastapi backend compiler", applicants="300 applicants", posted="2026-09-25")
        b = posting("2", desc="java", applicants="10 applicants", posted="2026-10-08")
        d = posting("3", desc="python", applicants="", posted="")
        self.assertEqual([p.id for p in screen.shortlist([d, b, a], c, TODAY)], ["1", "2"])


def eligibility(**over) -> Eligibility:
    base = dict(citizenship="not_required", citizenship_quote="", clearance="none", clearance_quote="",
                reposted=False, reposted_quote="")
    return Eligibility(**{**base, **over})


def skills(years=None, years_quote="", stack="Python", *marks) -> Skills:
    return Skills(years, years_quote, stack, tuple(SkillMark(n, st) for n, st in marks))


class Verdicts(unittest.TestCase):
    def test_eligibility_parses_a_clean_answer(self):
        v = passes.parse_eligibility('{"citizenship": "open", "citizenship_quote": "EU work permit holders welcome",'
                                     ' "clearance": "none", "clearance_quote": "", "reposted": false, "reposted_quote": ""}')
        self.assertEqual((v.citizenship, v.clearance, v.reposted), ("open", "none", False))
        self.assertEqual(v.citizenship_quote, "EU work permit holders welcome")
        self.assertEqual(Eligibility.from_dict(v.to_dict()), v)

    def test_eligibility_maps_sloppy_values_to_the_dropping_side(self):
        v = passes.parse_eligibility('Sure:\n```json\n{"citizenship": "Unclear", "clearance": "Not Required",'
                                     ' "reposted": "yes", "reposted_quote": "Posted  by\\n Recruit Co"}\n```')
        self.assertEqual((v.citizenship, v.clearance, v.reposted), ("required", "required", True))
        self.assertEqual(v.reposted_quote, "Posted by Recruit Co")
        with self.assertRaises(ValueError):
            passes.parse_eligibility("I cannot tell.")

    def test_skills_parses_years_stack_and_marks(self):
        v = passes.parse_skills('{"years": "4+", "years_quote": "4+ years required", "stack": "Java, Spring",'
                                ' "skills": [{"name": "Java", "status": "Missing"}, {"name": "SQL", "status": "has"},'
                                ' {"name": "Kafka", "status": "nope"}, "Terraform"]}')
        self.assertEqual((v.years, v.stack), (4, "Java, Spring"))
        self.assertEqual([(m.name, m.status) for m in v.skills],
                         [("Java", "missing"), ("SQL", "has"), ("Kafka", "missing"), ("Terraform", "missing")])
        self.assertIsNone(passes.parse_skills('{"years": null, "skills": []}').years)
        self.assertIsNone(passes.parse_skills('{"years": "none stated", "skills": []}').years)
        self.assertEqual(Skills.from_dict(json.loads(json.dumps(v.to_dict()))), v)

    def test_eligibility_reason_covers_every_branch(self):
        c = criteria()
        self.assertIsNone(passes.eligibility_reason(eligibility(), c))
        self.assertIsNone(passes.eligibility_reason(eligibility(citizenship="open", clearance="obtainable"), c))
        self.assertEqual(passes.eligibility_reason(eligibility(citizenship="required", citizenship_quote="US citizens only"), c),
                         "citizenship required: US citizens only")
        self.assertEqual(passes.eligibility_reason(eligibility(clearance="required", clearance_quote="active TS/SCI"), c),
                         "clearance required: active TS/SCI")
        self.assertEqual(passes.eligibility_reason(eligibility(reposted=True, reposted_quote="via Jobright"), c),
                         "reposted: via Jobright")

    def test_skills_reason_covers_years_stack_and_missing_count(self):
        c = criteria(max_years=2, max_missing=3, never_stack=(r"\bjava\b",))
        self.assertIsNone(passes.skills_reason(skills(2, "2 years", "Python", ("Python", "has")), c))
        self.assertIsNone(passes.skills_reason(skills(None, "", "Python", ("Python", "has"), ("Go", "missing")), c))
        self.assertEqual(passes.skills_reason(skills(4, "4+ years of Python", "Python"), c), "asks 4 years: 4+ years of Python")
        self.assertEqual(passes.skills_reason(skills(1, "", "Java and Spring"), c), "primary stack Java and Spring is on the never list")
        self.assertIsNone(passes.skills_reason(skills(1, "", "JavaScript"), c))
        self.assertEqual(passes.skills_reason(skills(None, "", "Python", ("Go", "missing"), ("K8s", "missing"),
                                                     ("Rust", "missing"), ("SQL", "has")), c),
                         "missing 3 of 4 required skills: Go, K8s, Rust")
        self.assertIsNone(passes.skills_reason(skills(None, "", "Python", ("Go", "missing"), ("K8s", "missing")), c))

    def test_criteria_hash_follows_the_fields_that_shape_a_verdict(self):
        c = criteria()
        h = criteria_hash(c, "Python")
        self.assertEqual(len(h), 12)
        self.assertEqual(h, criteria_hash(criteria(count=3), "Python"))
        self.assertNotEqual(h, criteria_hash(criteria(max_years=5), "Python"))
        self.assertNotEqual(h, criteria_hash(c, "Python, Java"))

    def test_criteria_loads_the_new_keys_with_defaults(self):
        c = criteria()
        self.assertEqual(c.targets, {"home": 20, "remote": 20})
        self.assertEqual(c.job_types, ("F",))
        self.assertIn("EU citizen", c.work_status)
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "c.json"
            path.write_text(json.dumps({"queries": [{"keywords": "x", "location": "y"}], "profile": "p",
                                        "targets": {"remote": 5}}))
            old = Criteria.load(path)
        self.assertEqual((old.targets, old.max_missing, old.pool_days, old.job_types), ({"home": 100, "remote": 5}, 3, 30, ()))
        self.assertEqual(old.skills_note, "Atlas/Work/Skills & Certifications.md")

    def test_prompts_name_the_posting_the_status_and_the_inventory(self):
        c = criteria()
        e = passes.eligibility_prompt(posting(desc="Must hold an EU work permit."), c)
        self.assertTrue(e.startswith(passes.ELIGIBILITY_HEAD))
        self.assertIn("EU citizen", e)
        self.assertIn("Must hold an EU work permit.", e)
        s = passes.skills_prompt(posting(), c, "- Python\n- FastAPI")
        self.assertTrue(s.startswith(passes.SKILLS_HEAD))
        self.assertIn("- FastAPI", s)
        self.assertIn("Junior Backend Engineer at Keel", s)


class PoolRecords(unittest.TestCase):
    def test_seen_ledger_migrates_to_picked_records_once(self):
        with tempfile.TemporaryDirectory() as d:
            path, seen = Path(d) / "pool.json", Path(d) / "seen.json"
            seen.write_text(json.dumps({"4": "2026-10-07"}))
            pool = poolmod.Pool.load(path, seen)
            self.assertEqual(pool.known("4").status, "picked")
            self.assertEqual(pool.known("4").picked, "2026-10-07")
            self.assertFalse(seen.exists())
            self.assertTrue(path.exists())
            again = poolmod.Pool.load(path, seen)
            self.assertEqual(again.known("4").status, "picked")
            self.assertIsNone(again.known("5"))

    def test_transitions_and_expiry(self):
        with tempfile.TemporaryDirectory() as d:
            pool = poolmod.Pool.load(Path(d) / "pool.json")
            pool.drop(posting("1", desc=""), "detail", "asks 4 years", "2026-10-08")
            pool.judged(posting("2", posted="2026-09-01"), "2026-10-08")
            pool.judged(posting("3", posted="2026-10-07"), "2026-10-08")
            pool.judged(posting("4", posted=""), "2026-10-08")
            self.assertEqual(sorted(pool.live()), ["2", "3", "4"])
            self.assertEqual(pool.expire(date(2026, 10, 8), 30), ["2"])
            self.assertEqual(pool.known("2").status, "expired")
            self.assertEqual(sorted(pool.live()), ["3", "4"])
            pool.pick("3", "2026-10-08")
            self.assertEqual((pool.known("3").status, pool.known("3").picked), ("picked", "2026-10-08"))
            self.assertEqual((pool.known("1").stage, pool.known("1").why, pool.known("1").title),
                             ("detail", "asks 4 years", "Junior Backend Engineer"))
            with self.assertRaises(KeyError):
                pool.pick("9", "2026-10-08")
            pool.save()
            back = poolmod.Pool.load(Path(d) / "pool.json")
            self.assertEqual(back.records, pool.records)


class Ranking(unittest.TestCase):
    def test_prompt_names_count_profile_and_every_card(self):
        c = criteria(count=3)
        text = rank.prompt([posting("1"), posting("2")], c, TODAY, "Atlas/Work/Work.md")
        self.assertIn("exactly 3", text)
        self.assertIn("Jordan", text)
        self.assertIn("id 1 |", text)
        self.assertIn("id 2 |", text)

    def test_parse_binds_ids_in_order_and_cuts_to_count(self):
        ps = [posting("1"), posting("2"), posting("3")]
        answer = ('Here you go:\n{"picks": [{"id": "2", "tier": "a", "why": "fits"}, {"id": "999", "tier": "A", "why": "x"},'
                  ' {"id": "2", "why": "dup"}, {"id": "1", "tier": "C", "why": "stretch"}, {"id": "3", "tier": "B", "why": "n"}],'
                  ' "dropped": [{"id": "3", "why": "far"}]}')
        picks, dropped = rank.parse(answer, ps, 2)
        self.assertEqual([(p.rank, p.posting.id, p.tier) for p in picks], [(1, "2", "A"), (2, "1", "C")])
        self.assertEqual([d.id for d in dropped], ["3"])

    def test_parse_rejects_an_answer_with_no_picks(self):
        with self.assertRaises(ValueError):
            rank.parse('{"picks": [], "dropped": []}', [posting("1")], 1)
        with self.assertRaises(ValueError):
            rank.parse("I cannot do that.", [posting("1")], 1)


class Reports(unittest.TestCase):
    def picks(self) -> list[Pick]:
        a = Pick(1, "A", "Closest stack match.", posting("1"), folder="/tmp/Jobs/01 Keel - Junior Backend Engineer", tailored=True)
        b = Pick(2, "B", "Crowded.", posting("2", company="Compiler & Sons", title="Engineer I, Platform_X"),
                 folder="/tmp/Jobs/02 Compiler", tailored=False, tailor_note="resume is 2 pages")
        return [a, b]

    def test_note_has_frontmatter_tiers_links_and_the_dropped_list(self):
        text = report.note(self.picks(), [Dropped("7", "rank", "too far")], TODAY, 120, 40)
        self.assertTrue(text.startswith("---\ntype: research\ntitle: Jobs top 2, 2026-10-08\n"))
        self.assertIn("## Tier A", text)
        self.assertIn("[Junior Backend Engineer](https://www.linkedin.com/jobs/view/1/)", text)
        self.assertIn("Tailoring failed (resume is 2 pages)", text)
        self.assertIn("- 7: too far", text)
        self.assertIn("120 unique postings", text)

    def test_failed_note_says_so(self):
        text = report.note([], [], TODAY, 0, 0, failed="search failed: throttled")
        self.assertIn("## The run failed", text)
        self.assertIn("throttled", text)

    def test_report_tex_escapes_and_links(self):
        text = report.report_tex(self.picks(), TODAY)
        self.assertIn(r"\textbf{Compiler \& Sons}", text)
        self.assertIn(r"Platform\_X", text)
        self.assertIn(r"\href{https://www.linkedin.com/jobs/view/1/}{Junior Backend Engineer}", text)
        self.assertIn("Tailoring failed: resume is 2 pages", text)
        self.assertIn(r"\end{document}", text)

    def test_todo_text_links_the_note(self):
        self.assertEqual(report.todo_text("2026-10-08-jobs-top-10", 10), "Apply to the 10 jobs in [[2026-10-08-jobs-top-10]]")
        self.assertEqual(report.todo_text("2026-10-08-jobs-top-10", 1), "Apply to the 1 job in [[2026-10-08-jobs-top-10]]")


class Tailoring(unittest.TestCase):
    def test_folder_name_is_rank_company_role_sanitised(self):
        pk = Pick(3, "A", "", posting(company="Keel/Co", title="Engineer: Backend*"))
        self.assertEqual(tailor.folder_name(pk), "03 Keel-Co - Engineer - Backend")

    def test_job_description_has_the_frontmatter_the_skill_reads(self):
        text = tailor.job_description(Pick(1, "A", "", posting()), TODAY)
        self.assertIn("company: Keel\n", text)
        self.assertIn("role: Junior Backend Engineer\n", text)
        self.assertIn("url: https://www.linkedin.com/jobs/view/1001/\n", text)
        self.assertIn("# Original JD", text)

    def test_prompt_is_headless(self):
        text = tailor.prompt(Path("/j/jd.md"), Path("/j"), TODAY)
        self.assertTrue(text.startswith("/resume-tailor\nheadless: true\n"))
        self.assertIn("out: /j\n", text)
        self.assertNotIn("retry", text)
        again = tailor.prompt(Path("/j/jd.md"), Path("/j"), TODAY, retry="resume names AWS")
        self.assertIn("retry: true", again)
        self.assertIn("resume names AWS", again)

    def test_check_fails_a_resume_that_names_a_denied_word(self):
        with tempfile.TemporaryDirectory() as d:
            folder = Path(d)
            (folder / "Jordan_Resume.pdf").write_bytes(b"%PDF")
            (folder / "Jordan_Cover_Letter.pdf").write_bytes(b"%PDF")
            deny = ("\\bAWS\\b", "\\bGo\\b")
            with mock.patch.object(tailor, "pdf_pages", return_value=1), \
                 mock.patch.object(tailor, "pdf_text", return_value="Tooling: Docker, AWS, Fly.io. Google Cloud."):
                self.assertEqual(tailor.check(folder, deny), "resume names AWS")
            with mock.patch.object(tailor, "pdf_pages", return_value=1), \
                 mock.patch.object(tailor, "pdf_text", return_value="Tooling: Docker, Fly.io. Gone to Google."):
                self.assertIsNone(tailor.check(folder, deny))

    def test_a_failed_attempt_is_retried_once_with_its_own_log(self):
        calls = []

        def fake_run(prompt, model, effort, cwd, timeout_s, read_only=False, stream=False):
            calls.append(prompt)
            if len(calls) == 2:
                (cwd / "Daniel_Gentile_Resume.pdf").write_bytes(b"%PDF")
                (cwd / "Daniel_Gentile_Cover_Letter.pdf").write_bytes(b"%PDF")
            return tailor.claude.Outcome("", "", 0, len(calls) == 1)

        with tempfile.TemporaryDirectory() as d:
            folder = Path(d) / "01 Keel - Engineer"
            log = Path(d) / "tailor.log"
            with mock.patch.object(tailor.claude, "run", fake_run), \
                 mock.patch.object(tailor.claude, "registry", lambda k, n: ("opus", "high")), \
                 mock.patch.object(tailor, "pdf_pages", return_value=1):
                # the fake writes into cwd, so point the vault at the folder
                pk = tailor.tailor(Pick(1, "A", "", posting()), folder, folder, TODAY, log)
            self.assertTrue(pk.tailored)
            self.assertEqual(len(calls), 2)
            self.assertIn("retry: true", calls[1])
            self.assertIn("no resume PDF", calls[1])
            self.assertIn("timed out", log.read_text())
            self.assertTrue(log.with_suffix(".retry.log").exists())

    def test_check_wants_both_pdfs(self):
        with tempfile.TemporaryDirectory() as d:
            folder = Path(d)
            self.assertEqual(tailor.check(folder), "no resume PDF")
            (folder / "Jordan_Resume.pdf").write_bytes(b"%PDF")
            self.assertEqual(tailor.check(folder), "no cover letter PDF")
            (folder / "Jordan_Cover_Letter.pdf").write_bytes(b"%PDF")
            with mock.patch.object(tailor, "pdf_pages", return_value=1):
                self.assertIsNone(tailor.check(folder))
            with mock.patch.object(tailor, "pdf_pages", return_value=2):
                self.assertEqual(tailor.check(folder), "resume is 2 pages")


class Orchestration(unittest.TestCase):
    """The whole run with the network and the model faked, against a copy of the demo vault
    and a temp state directory. What it proves: the ledger hides yesterday's picks, every stage
    file lands, the note and the status are written, and a rerun is a no-op."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.vault = root / "vault"
        import shutil
        shutil.copytree(DEMO, self.vault)
        self.state = root / "state"
        self.desktop = root / "desktop"
        self.env = mock.patch.dict(os.environ, {"HELM_STATE": str(self.state), "HELM_VAULT_ROOT": str(self.vault)})
        self.env.start()
        sys.modules.pop("run", None)
        import run  # noqa: E402
        self.run = run
        run.STATE, run.VAULT = self.state, self.vault

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def fake_search(self, q, c, known, want, pause_s=0.6):
        return [Posting("1", "Junior Backend Engineer", "Keel", "Lisbon", "2026-10-06", q.keywords),
                Posting("2", "Senior Engineer", "Compiler", "Remote", "2026-10-05", q.keywords),
                Posting("3", "Backend Engineer", "Priya Systems", "Lisbon", "2026-10-07", q.keywords),
                Posting("4", "Engineer I", "Sam Ltd", "Remote", "2026-10-07", q.keywords)]

    def fake_fetch(self, p, tries=3, pause_s=0):
        p.description = {"1": "Python, FastAPI, 1+ years.", "3": "US citizenship is required.",
                         "4": "Python backend, no years stated."}[p.id]
        p.applicants = "12 applicants"
        return p

    def fake_claude(self, prompt, model, effort, cwd, timeout_s, read_only=False):
        ids = [line.split()[1] for line in prompt.splitlines() if line.startswith("id ")]
        picks = [{"id": i, "tier": "A", "why": f"fits {i}"} for i in ids]
        return self.run.claude.Outcome(json.dumps({"picks": picks, "dropped": []}), "", 0, False)

    def test_full_run_with_the_ledger_hiding_an_earlier_pick(self):
        (self.state / "status/job-search").mkdir(parents=True)
        (self.state / "status/job-search/seen.json").write_text(json.dumps({"4": "2026-10-07"}))
        with mock.patch.object(self.run.linkedin, "search", self.fake_search), \
             mock.patch.object(self.run.linkedin, "fetch_posting", self.fake_fetch), \
             mock.patch.object(self.run.claude, "run", self.fake_claude), \
             mock.patch.object(self.run.report, "compile_pdf", lambda tex, pdf: pdf.write_bytes(b"%PDF") and None):
            rc = self.run.main(["--day", "2026-10-08", "--desktop", str(self.desktop), "--no-tailor"])
        self.assertEqual(rc, 0)
        day = self.state / "status/job-search/2026-10-08"
        dropped = {d["id"]: d["why"] for d in json.loads((day / "dropped-search.json").read_text())}
        self.assertIn("senior", dropped["2"])
        self.assertEqual(dropped["4"], "picked 2026-10-07")
        self.assertEqual([d["id"] for d in json.loads((day / "dropped-detail.json").read_text())], ["3"])
        picks = json.loads((day / "picks.json").read_text())
        self.assertEqual([p["posting"]["id"] for p in picks], ["1"])
        pool = json.loads((self.state / "status/job-search/pool.json").read_text())
        self.assertFalse((self.state / "status/job-search/seen.json").exists())
        self.assertEqual({k: v["status"] for k, v in pool.items()},
                         {"1": "picked", "2": "dropped", "3": "dropped", "4": "picked"})
        self.assertEqual((pool["1"]["picked"], pool["3"]["stage"]), ("2026-10-08", "detail"))
        note = (self.vault / "Atlas/Work/research/2026-10-08-jobs-top-10.md").read_text()
        self.assertIn("**Keel**, [Junior Backend Engineer](https://www.linkedin.com/jobs/view/1/)", note)
        self.assertTrue((self.desktop / "Jobs 2026-10-08.pdf").exists())
        status = json.loads((self.state / "status/job-search.json").read_text())
        self.assertEqual((status["result"], status["picks"], status["day"]), ("pass", 1, "2026-10-08"))
        work = (self.vault / "Atlas/Work/Work.md").read_text()
        self.assertIn("- [ ] Apply to the 1 job in [[2026-10-08-jobs-top-10]] (due: 2026-10-08)", work)

    def test_a_failed_stage_still_leaves_a_report_and_a_failed_status(self):
        def boom(*a, **k):
            raise RuntimeError("throttled")
        with mock.patch.object(self.run.linkedin, "search", boom), \
             mock.patch.object(self.run.report, "compile_pdf", lambda tex, pdf: pdf.write_bytes(b"%PDF") and None):
            rc = self.run.main(["--day", "2026-10-08", "--desktop", str(self.desktop)])
        self.assertEqual(rc, 1)
        note = (self.vault / "Atlas/Work/research/2026-10-08-jobs-top-10.md").read_text()
        self.assertIn("## The run failed", note)
        self.assertIn("throttled", note)
        status = json.loads((self.state / "status/job-search.json").read_text())
        self.assertEqual(status["result"], "fail")
        self.assertTrue((self.desktop / "Jobs 2026-10-08.pdf").exists())


if __name__ == "__main__":
    unittest.main()
