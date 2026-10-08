"""What the owner reads: a research note in the vault and a PDF on the desktop.

The note is the record and links the application folders. The PDF is the morning view,
compiled with xelatex from text this module generates, with every posting title a link.
Both are regenerated whole on every run, so a rerun overwrites rather than appends.
"""
from __future__ import annotations

import os
import re
import subprocess
from datetime import date
from pathlib import Path

from model import Dropped, Pick

_TEX_SPECIAL = {"\\": r"\textbackslash{}", "&": r"\&", "%": r"\%", "$": r"\$", "#": r"\#",
                "_": r"\_", "{": r"\{", "}": r"\}", "~": r"\textasciitilde{}", "^": r"\textasciicircum{}"}


def tex(s: str) -> str:
    return "".join(_TEX_SPECIAL.get(ch, ch) for ch in s)


def tex_url(s: str) -> str:
    return s.replace("\\", "/").replace("%", r"\%").replace("#", r"\#")



def note_stem(today: date, count: int) -> str:
    return f"{today.isoformat()}-jobs-top-{count}"


def _line(pick: Pick) -> str:
    p = pick.posting
    bits = [p.location]
    if p.applicants:
        bits.append(p.applicants)
    if p.easy_apply:
        bits.append("Easy Apply")
    if p.posted:
        bits.append(f"posted {p.posted}")
    tail = f" Folder: `{pick.folder}`." if pick.folder else ""
    if pick.folder and not pick.tailored:
        tail += f" Tailoring failed ({pick.tailor_note}); apply with a standing variant."
    return (f"{pick.rank}. **{p.company}**, [{p.title}]({p.url}), {', '.join(bits)}. "
            f"{pick.why}{tail}")


def note(picks: list[Pick], dropped: list[Dropped], today: date, searched: int, screened: int,
         failed: str | None = None) -> str:
    count = len(picks)
    head = (f"---\ntype: research\ntitle: Jobs top {count}, {today.isoformat()}\n"
            f"updated: {today.isoformat()}\n"
            f"tags: [job-search, linkedin, postings, routine]\n---\n\n"
            f"# Jobs top {count}, {today.isoformat()}\n\n"
            f"**Related:** [[Job Search]] · [[Applications & Roles]]\n\n"
            f"Written by helm's `job-search` routine. {searched} unique postings from LinkedIn, "
            f"{screened} left after the title, clearance, citizenship, sponsorship and years screen, "
            f"{count} picked. Goal: apply to every one today.\n\n")
    if failed:
        return head + f"## The run failed\n\n{failed}\n"
    tiers = {"A": "## Tier A: apply first\n\n", "B": "## Tier B: solid fit, more competition\n\n",
             "C": "## Tier C: stretch\n\n"}
    body = ""
    for t in ("A", "B", "C"):
        rows = [pk for pk in picks if pk.tier == t]
        if rows:
            body += tiers[t] + "\n".join(_line(pk) for pk in rows) + "\n\n"
    if dropped:
        body += "## Dropped at ranking\n\nSo nobody re-checks them.\n\n"
        body += "\n".join(f"- {d.id}: {d.why}" for d in dropped) + "\n"
    return head + body


def report_tex(picks: list[Pick], today: date, failed: str | None = None) -> str:
    count = len(picks)
    head = r"""\documentclass[11pt]{article}
\usepackage[margin=1in]{geometry}
\usepackage{fontspec}
\usepackage[colorlinks=true,urlcolor=blue,linkcolor=black]{hyperref}
\usepackage{enumitem}
\setlength{\parskip}{6pt}
\setlength{\parindent}{0pt}
\pagestyle{empty}
\begin{document}
"""
    title = f"\\section*{{Jobs for {tex(today.strftime('%A %d %B %Y'))}}}\n"
    if failed:
        return head + title + f"The run failed.\n\n{tex(failed)}\n\\end{{document}}\n"
    intro = (f"{count} postings, best first. Each title is the apply link. Each folder holds a tailored "
             f"resume, a cover letter and tailoring notes; read the notes before sending.\n\n")
    items = ""
    for pk in picks:
        p = pk.posting
        meta = [tex(p.location)]
        if p.applicants:
            meta.append(tex(p.applicants))
        if p.easy_apply:
            meta.append("Easy Apply")
        if p.posted:
            meta.append(f"posted {tex(p.posted)}")
        items += (f"\\item[{pk.rank}.] \\textbf{{{tex(p.company)}}}, "
                  f"\\href{{{tex_url(p.url)}}}{{{tex(p.title)}}}. Tier {pk.tier}. {', '.join(meta)}.\\\\\n"
                  f"{tex(pk.why)}\\\\\n")
        if pk.folder:
            items += f"\\href{{file://{tex_url(pk.folder)}}}{{\\small\\texttt{{{tex(Path(pk.folder).name)}}}}}"
            if not pk.tailored:
                items += f" \\small Tailoring failed: {tex(pk.tailor_note)}. Apply with a standing variant."
            items += "\n"
    return (head + title + intro + "\\begin{description}[leftmargin=2.2em,style=unboxed]\n"
            + items + "\\end{description}\n\\end{document}\n")


def compile_pdf(tex_path: Path, out_pdf: Path) -> str | None:
    """xelatex in the tex file's folder; the PDF moves to `out_pdf`. None on success."""
    env = {**os.environ, "PATH": "/Library/TeX/texbin:" + os.environ.get("PATH", "")}
    r = subprocess.run(["xelatex", "-interaction=nonstopmode", "-halt-on-error", tex_path.name],
                       cwd=str(tex_path.parent), capture_output=True, text=True, env=env)
    produced = tex_path.with_suffix(".pdf")
    for ext in (".aux", ".log", ".out"):
        tex_path.with_suffix(ext).unlink(missing_ok=True)
    if r.returncode != 0 or not produced.exists():
        return r.stdout[-1500:]
    produced.replace(out_pdf)
    tex_path.unlink(missing_ok=True)
    return None


def todo_text(stem: str, picked: int) -> str:
    noun = "job" if picked == 1 else "jobs"
    return f"Apply to the {picked} {noun} in [[{stem}]]"
