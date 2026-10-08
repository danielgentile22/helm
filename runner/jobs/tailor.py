"""One headless resume-tailor run per pick, into the day's desktop folder.

The skill lives in the owner's skills folder and reads the vault for the master files; this
module only names the job folder, writes the posting as the `job_description.md` the skill
expects, runs it, and checks what came back: a resume PDF of exactly one page and a cover
letter PDF. A pick whose run fails is tried once more; a second failure keeps its folder and both logs,
and the report says so.

The skill's headless mode reads five files and compiles two PDFs, which takes about ten
minutes; the budget below is three times that. A run that reaches it wandered (repo reads,
web searches), and the streamed log shows where.
"""
from __future__ import annotations

import os
import re
import subprocess
from datetime import date
from pathlib import Path

import claude
from model import Pick

SKILL = "resume-tailor"
TIMEOUT_S = 35 * 60


def folder_name(pick: Pick) -> str:
    p = pick.posting
    raw = f"{pick.rank:02d} {p.company} - {p.title}"
    raw = raw.replace("/", "-").replace(":", " -")
    raw = re.sub(r'[*?<>|"]', "", raw)
    return re.sub(r"\s+", " ", raw).strip()[:120]


def job_description(pick: Pick, today: date) -> str:
    p = pick.posting
    paragraphs = re.sub(r"(?<=[.:;])\s+(?=[A-Z•-])", "\n\n", p.description)
    return (f"---\ncompany: {p.company}\nrole: {p.title}\nlocation: {p.location}\n"
            f"url: {p.url}\nsource: linkedin\nposted: {p.posted}\napplicants: {p.applicants}\n"
            f"easy_apply: {'yes' if p.easy_apply else 'no'}\nfound: {today.isoformat()}\n---\n\n"
            f"# Original JD\n\n{paragraphs}\n")


def prompt(jd: Path, out: Path, today: date, retry: str | None = None) -> str:
    text = f"/{SKILL}\nheadless: true\njd: {jd}\nout: {out}\nnow: {today.isoformat()}"
    if retry:
        text += (f"\nretry: true\nThe first attempt failed: {retry}. Read the five files, edit, "
                 "compile, write the notes. Nothing else.")
    return text


POPPLER_PATH = "/opt/homebrew/bin:/usr/local/bin:" + os.environ.get("PATH", "")


def pdf_pages(pdf: Path) -> int | None:
    """From pdfinfo (poppler), which the resume-tailor skill already relies on. None when it
    is not installed, so a missing tool never reads as a two-page resume."""
    try:
        r = subprocess.run(["pdfinfo", str(pdf)], capture_output=True, text=True,
                           env={**os.environ, "PATH": POPPLER_PATH})
    except FileNotFoundError:
        return None
    m = re.search(r"^Pages:\s+(\d+)", r.stdout, re.M)
    return int(m.group(1)) if m else None


def pdf_text(pdf: Path) -> str:
    """From pdftotext (poppler). Empty when it is not installed."""
    try:
        r = subprocess.run(["pdftotext", str(pdf), "-"], capture_output=True, text=True,
                           env={**os.environ, "PATH": POPPLER_PATH})
    except FileNotFoundError:
        return ""
    return r.stdout


def denied(text: str, deny: tuple[str, ...]) -> list[str]:
    """The words the resume must not carry, as the owner's criteria list them."""
    hits = []
    for pattern in deny:
        m = re.search(pattern, text)
        if m:
            hits.append(m.group(0))
    return hits


def check(folder: Path, deny: tuple[str, ...] = ()) -> str | None:
    """None when the folder holds what the owner needs, else what is missing or wrong."""
    resumes = [p for p in folder.glob("*.pdf") if "resume" in p.name.lower()]
    letters = [p for p in folder.glob("*.pdf") if "cover" in p.name.lower()]
    if not resumes:
        return "no resume PDF"
    if not letters:
        return "no cover letter PDF"
    pages = pdf_pages(resumes[0])
    if pages not in (None, 1):
        return f"resume is {pages} pages"
    hits = denied(pdf_text(resumes[0]), deny) if deny else []
    if hits:
        return "resume names " + ", ".join(sorted(set(hits)))
    return None


def attempt(jd: Path, folder: Path, vault: Path, today: date, log: Path, deny: tuple[str, ...],
            retry: str | None) -> str | None:
    model, effort = claude.registry("skills", SKILL)
    out = claude.run(prompt(jd, folder, today, retry), model, effort, cwd=vault,
                     timeout_s=TIMEOUT_S, stream=True)
    log.write_text(out.stdout + ("\n--- stderr ---\n" + out.stderr if out.stderr else "")
                   + ("\n--- timed out ---\n" if out.timed_out else ""))
    problem = check(folder, deny)
    if out.timed_out:
        problem = problem or "timed out"
    return problem


def tailor(pick: Pick, folder: Path, vault: Path, today: date, log: Path,
           deny: tuple[str, ...] = ()) -> Pick:
    folder.mkdir(parents=True, exist_ok=True)
    jd = folder / "job_description.md"
    jd.write_text(job_description(pick, today))
    problem = attempt(jd, folder, vault, today, log, deny, retry=None)
    if problem:
        problem = attempt(jd, folder, vault, today, log.with_suffix(".retry.log"), deny, retry=problem)
    pick.folder = str(folder)
    pick.tailored = problem is None
    pick.tailor_note = problem or ""
    return pick
