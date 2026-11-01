# helm

A personal project manager: a public engine that reads one person's private vault and shows
their projects, ideas, background routines and devices.
The words below mean specific things here.

## Language

### Structure

**Department**:
One of the four top-level divisions of the owner's work and life: Work, Projects,
Chess, Life. Every task belongs to exactly one. Hardcoded in the engine.
_Avoid_: area, category, pillar, domain

**Router**:
A pointer file that tells an agent where to go next and nothing else. Never
documentation, never longer than a page.
_Avoid_: index, hub, map, table of contents

**Pointer**:
One line in a router: a real path, a dash, and a short gloss. Typed by what it
leads to (`Skills:`, `Files:`, `Reference:`, `Thinking:`, `Rules:`).
_Avoid_: link, reference, entry

**Stale pointer**:
A pointer whose path no longer exists. Worse than no pointer, because an agent
that follows one falls back to globbing. The integrity check exists to find these.

**Not here**:
The closing section of every router, naming what the department does not cover
and which department does. Prevents the expensive failure, which is reading the
wrong router and then searching blindly.

**Mount point**:
A directory whose contents are composed from several separately maintained
sources by symlink. The owner's skills folder is one.

### The system

**Helm**:
The whole system: the engine plus the vault it reads. Absorbed the private repo
once called otto. The engine is public; the vault never is.
_Avoid_: otto (retired name), HUD, the app

**Engine**:
This repo: code, generic docs, a demo vault. Knows nothing about its owner until it
reads a vault.
_Avoid_: platform, framework

**Vault**:
The second brain: the owner's Obsidian notes, at `HELM_VAULT_ROOT` (default `~/Vault`). Its own git repo, no
remote, ever. Knowledge only, never runtime state and never code.
_Avoid_: notes, Obsidian, knowledge base

**State**:
What the software writes for itself: caches, credentials, run records, status files and
logs. Lives at `~/.helm/` (`HELM_STATE`), never in the vault and never in the engine.
Mostly disposable; credentials are the part worth backing up.
_Avoid_: data, runtime, system folder

**Atlas**:
The canonical knowledge inside the vault, at `Vault/Atlas/`. The folder an agent
opens to reach a fact. Holds the four departments and, inside each, the research
and files that department owns, plus `Atlas/Ideas/`, which spans them. The only things
outside it are `Vault/Inbox/`, which is transient, and `Vault/Archive/`, which is cold.

**Routine**:
Work helm runs for itself on a schedule under launchd: a script, a prompt sent to
`claude -p`, or both. Listed with its schedule in `models.json`, and can be run now,
paused or resumed.
_Avoid_: job, cron, task, automation

**Service**:
Something that runs all the time rather than on a schedule: a local server, a tunnel, a
keep-awake process. Shown beside routines but never paused from the phone.
_Avoid_: daemon, agent

**Paused**:
A routine that is not loaded in launchd and whose settings file sits in `~/.helm/disabled/`.
The only way a routine is stopped on purpose.
_Avoid_: disabled, off, stopped

**Pool**:
The job search's record of every posting it has met, one entry per posting with a
status: judged, dropped, picked or expired. A judged posting waits for a thinner
morning; a picked one is never shown again. `~/.helm/status/job-search/pool.json`.
_Avoid_: seen ledger, seen.json (replaced), history

**Verdict**:
A model pass's answer about one posting, in a fixed JSON form (eligibility: citizenship,
clearance, reposted; skills: years floor, primary stack, each required skill). Code
decides the drop from the form; the quoted sentence is the reason. Cached per posting
with a key over what shaped the pass's question.
_Avoid_: judgement, assessment, score

**Funnel**:
What a job-search morning did, computed from the stage files: pulled per bucket,
already in the pool, removed by each stage, carried, ranked, overturned, picked, and
the cost per stage. Opens the morning note, sits on the PDF, and lands in the day's
state as `funnel.json`.
_Avoid_: stats, summary, pipeline metrics

**Runner**:
The component that holds schedules, run records, and metrics, and invokes Claude
for routines. Successor to HELM's runner, without its file-based queue.

**Skill**:
A packaged procedure invocable as a command. helm routes to skills and records
which model each runs at in `models.json`; it owns only the two in `skills/`.

**Directive**:
A department's standing goal. Every department has them; three anywhere in the tree
are starred as the current priorities, and the list in the vault's `CLAUDE.md` renders those
three rather than holding a separate list. A star is written on the heading, `### Launch ★1`.
A directive is never finished.
_Avoid_: goal, objective, priority, OKR

**Idea**:
Anything the owner might do, thrown in as one sentence and kept as its own note. Belongs
to a project or straight to a department. Open until it is done, dropped, or promoted. An
idea with a due date is what used to be called a todo.
_Avoid_: todo (retired), task, item, note

**Promote**:
To turn an idea into an issue in its project's tracker. The idea stays, marked promoted,
and points at the issue.
_Avoid_: convert, file, escalate

**Project**:
One thing the owner builds, with a note in the vault and one or more repos. Has exactly
one tracker.
_Avoid_: repo (a project can span several), app

**Tracker**:
Where a project's issues live: its GitHub Issues by default, or a workspace's local
`.scratch/<slug>/issues/` folder when it has one, in which case the repos' GitHub Issues
are not read.
_Avoid_: backlog, board

**Issue**:
A tracked unit of engineering work in a project's tracker. Not an idea: an idea is a
thought, an issue is work someone has decided to do.

**In flight**:
Work that is started and unfinished, derived from a repo rather than declared: an
unmerged branch, an uncommitted change, an open effort. Nobody writes it down, so
nobody has to remember to.

**Device**:
A piece of hardware the owner owns, with one note in the vault: its specs, its role, and
whether it hosts T3 Code, reaches it as a client, or neither. Online status comes live from
the tailnet, never from the note.
_Avoid_: machine (only computers), gadget, asset

### Boundaries

**Employer content**:
Source code, internal documents, tickets and customer data from the owner's employer.
Never enters helm or the vault under any circumstance. The Work department holds
only the owner's own layer about the job.

**Sensitive**:
Material tagged `#sensitive`: legal, medical, financial, and other people's private
information. Lives only inside the vault, never copied into a repo, a commit message,
or anything shareable without flagging it first.
