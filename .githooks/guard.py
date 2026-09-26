#!/usr/bin/env python3
"""Personal-data guard for a public repo. Runs from pre-commit, commit-msg and pre-push.

helm is public and commits go straight to main, so this is the only thing between a
mistake and a permanent leak. It checks three things on every added line, path and
commit message:

1. A deny list of personal names and terms, kept OUTSIDE the repo (default
   ~/.helm/guard/deny.txt, or $HELM_GUARD_DENY). No deny list means every check fails.
2. .githooks/paths: which paths may be added or changed at all.
3. Generic patterns: secrets, email addresses, phone numbers, and commit message rules.

A line may opt out of the generic patterns (never the deny list) by carrying the
marker `guard:allow`, which stays visible in review.

Usage: guard.py staged | guard.py message <file> | guard.py push (pre-push stdin)
"""
import os
import re
import subprocess
import sys
from pathlib import Path

Z40 = "0" * 40
ROOT = Path(subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True, check=True).stdout.strip())
ALLOW_MARK = "guard:allow"

SECRETS = [
    ("Anthropic key", r"sk-ant-[A-Za-z0-9_-]{20,}"),
    ("OpenAI-style key", r"\bsk-[A-Za-z0-9]{32,}"),
    ("AWS access key", r"\bAKIA[0-9A-Z]{16}\b"),
    ("GitHub token", r"\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})"),
    ("Slack token", r"\bxox[abprs]-[A-Za-z0-9-]{10,}"),
    ("Google API key", r"\bAIza[0-9A-Za-z_-]{35}\b"),
    ("private key", r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    ("assigned secret", r"(?i)\b(api[_-]?key|secret|token|password|passwd)\b\s*[:=]\s*['\"][A-Za-z0-9_+/=.-]{20,}['\"]"),
]
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}")
EMAIL_OK = re.compile(r"@((.*\.)?example\.(com|org|net)|.*\.(test|invalid|example|local)|users\.noreply\.github\.com|anthropic\.com)$", re.I)
PHONE = re.compile(r"(?<![\w.-])\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?![\w-])")
MESSAGE_RULES = [
    ("em dash", r"—"),
    ("en dash used as punctuation", r"\s–\s"),
    ("session link", r"(?i)claude-session:|claude\.ai/code/session"),
]


def fail_closed(msg):
    print(f"GUARD BLOCKED: {msg}", file=sys.stderr)
    sys.exit(1)


def load_deny():
    path = Path(os.environ.get("HELM_GUARD_DENY") or Path.home() / ".helm/guard/deny.txt")
    if not path.is_file():
        fail_closed(f"no deny list at {path}. The guard fails closed; create it (one term per line) before committing.")
    terms = []
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        body = line[3:] if line.startswith("re:") else re.escape(line)
        terms.append((line, re.compile(rf"(?<![A-Za-z0-9]){body}(?![A-Za-z0-9])", re.I)))
    if not terms:
        fail_closed(f"deny list {path} is empty")
    return terms


def load_paths():
    allow, deny = [], []
    for raw in (ROOT / ".githooks/paths").read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        (deny if line.startswith("!") else allow).append(re.compile(line.lstrip("!")))
    return allow, deny


def git(*args):
    return subprocess.run(["git", *args], capture_output=True, text=True, check=True, cwd=ROOT).stdout


def added_lines(diff):
    """Yield (path, line_no, text) for each added line of a unified diff made with -U0."""
    path, n = None, 0
    for line in diff.splitlines():
        if line.startswith("+++ "):
            path = None if line == "+++ /dev/null" else line[6:]
        elif line.startswith("@@"):
            n = int(re.search(r"\+(\d+)", line).group(1))
        elif line.startswith("+") and path:
            yield path, n, line[1:]
            n += 1


class Report:
    def __init__(self):
        self.problems = []

    def add(self, where, what):
        self.problems.append(f"  {where}: {what}")

    def finish(self, context):
        if self.problems:
            print(f"GUARD BLOCKED ({context}). This repo is public; fix these or move the content to the vault:", file=sys.stderr)
            print("\n".join(self.problems), file=sys.stderr)
            sys.exit(1)


def check_paths(paths, report, deny_terms):
    allow, deny = load_paths()
    for p in paths:
        if any(d.search(p) for d in deny):
            report.add(p, "path is on the denied list in .githooks/paths")
        elif not any(a.search(p) for a in allow):
            report.add(p, "path is not on the allowed list in .githooks/paths")
        for term, rx in deny_terms:
            if rx.search(p):
                report.add(p, f"path contains a denied term ({term})")


def check_diff(diff, report, deny_terms):
    for path, n, text in added_lines(diff):
        where = f"{path}:{n}"
        for term, rx in deny_terms:
            if rx.search(text):
                report.add(where, f"denied term ({term})")
        if ALLOW_MARK in text:
            continue
        for name, rx in SECRETS:
            if re.search(rx, text):
                report.add(where, f"matches the {name} pattern")
        for m in EMAIL.finditer(text):
            if not EMAIL_OK.search(m.group(0)):
                report.add(where, f"email address {m.group(0)}")
        if PHONE.search(text):
            report.add(where, "matches the phone number pattern")


def check_message(msg, report, deny_terms, where):
    body = "\n".join(l for l in msg.splitlines() if not l.startswith("#"))
    for term, rx in deny_terms:
        if rx.search(body):
            report.add(where, f"commit message has a denied term ({term})")
    for name, rx in MESSAGE_RULES:
        if re.search(rx, body):
            report.add(where, f"commit message has an {name}" if name[0] in "ae" else f"commit message has a {name}")


def changed_paths(name_status):
    return [line.split("\t")[-1] for line in name_status.splitlines() if line and line[0] in "ACMR"]


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    deny_terms = load_deny()
    report = Report()
    if mode == "staged":
        check_paths(changed_paths(git("diff", "--cached", "-M", "--name-status")), report, deny_terms)
        check_diff(git("diff", "--cached", "-M", "-U0", "--no-color", "--diff-filter=ACMR"), report, deny_terms)
        report.finish("pre-commit")
    elif mode == "message":
        check_message(Path(sys.argv[2]).read_text(), report, deny_terms, "commit message")
        report.finish("commit-msg")
    elif mode == "push":
        for line in sys.stdin.read().splitlines():
            local_ref, local_sha, _remote_ref, _remote_sha = line.split()
            if local_sha == Z40:
                continue
            remote = sys.argv[2] if len(sys.argv) > 2 else "origin"
            for sha in git("rev-list", local_sha, "--not", f"--remotes={remote}").split():
                short = sha[:8]
                paths = changed_paths(git("show", "-M", "--format=", "--name-status", sha))
                sub = Report()
                check_paths(paths, sub, deny_terms)
                check_diff(git("show", "-M", "-U0", "--no-color", "--format=", "--diff-filter=ACMR", sha), sub, deny_terms)
                check_message(git("log", "-1", "--format=%B", sha), sub, deny_terms, "message")
                report.problems += [f"  {short}{p[1:]}" if p.startswith("  ") else p for p in sub.problems]
        report.finish("pre-push")
    else:
        fail_closed(f"unknown mode {mode!r}")


if __name__ == "__main__":
    main()
