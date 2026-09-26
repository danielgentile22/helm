# helm

A personal operating system: a public engine that reads one person's private vault.
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

**Helm Chat**:
The phone chat surface, where the phone talks to the vault. Formerly Helm 2.0 and
helm2.
_Avoid_: helm2, phone app, Helm 2.0

**Vault**:
The second brain: the owner's Obsidian notes, at `HELM_VAULT_ROOT` (default `~/Vault`). Its own git repo, no
remote, ever. Knowledge only, never runtime state and never code.
_Avoid_: notes, Obsidian, knowledge base

**Talk**:
Speaking to helm: hold Space on the Mac, press the button on the phone. Belongs to
helm's views, not to Helm Chat, which is typed (the phone keyboard dictates).
Handles todos and short questions. A longer question gets a very brief answer and a
spoken nudge to take it to chat.
_Avoid_: voice mode, push-to-talk, assistant

**State**:
What the software writes for itself: chat threads, credentials, status files,
metrics, logs. Lives at `~/.helm/` (`HELM_STATE`), never in the vault and never in the engine.
Mostly disposable; chat threads and credentials are the parts worth backing up.
_Avoid_: data, runtime, system folder

**Atlas**:
The canonical knowledge inside the vault, at `Vault/Atlas/`. The folder an agent
opens to reach a fact. Holds the four departments and, inside each, the research
and files that department owns. The only things outside it are `Vault/Inbox/`,
which is transient, and `Vault/Archive/`, which is cold.

**Routine**:
A prompt helm sends to itself on a schedule, run headlessly through `claude -p`
under launchd.
_Avoid_: job, cron, task, automation

**Runner**:
The component that holds schedules, run records, and metrics, and invokes Claude
for routines. Successor to HELM's runner, without its file-based queue.

**Skill**:
A packaged procedure invocable as a command. helm routes to skills and records
which model each runs at in `models.json`; it owns only the two in `skills/`.

**Directive**:
A department's standing goal. Every department has them; three anywhere in the tree
are starred as the current priorities, and the list in the vault's `CLAUDE.md` renders those three
rather than holding a separate list. A star is written on the heading, `### Job search ★1`,
and weights the todos under it (ADR 0020). A directive is never finished, so it is never
escalated against.
_Avoid_: goal, objective, priority, OKR

**Todo**:
A unit of commitment that can be finished. Written as a markdown checkbox on a
department note in the vault, hanging off a directive or off the department directly.
May carry a `done-when` predicate that the nightly routine checks, so the box ticks
itself.
_Avoid_: task, item, action

**Issue**:
A tracked unit of engineering work living in a repo's tracker, GitHub Issues by
default, or `.scratch/<slug>/issues/` in a workspace that has one. Not a Todo: a
directive can have forty issues and no todos, or six todos and no repo.

**In flight**:
Work that is started and unfinished, derived from a repo rather than declared: an
unmerged branch, an uncommitted change, an open effort. Nobody writes it down, so
nobody has to remember to.

**Instrument**:
One pluggable renderer for the dashboard's hero slot. Swappable at runtime, always
redundant with the panels around it, never the only copy of anything.
_Avoid_: widget, visualisation, hero

### Boundaries

**Employer content**:
Source code, internal documents, tickets and customer data from the owner's employer.
Never enters helm or the vault under any circumstance. The Work department holds
only the owner's own layer about the job.

**Sensitive**:
Material tagged `#sensitive`: legal, medical, financial, and other people's private
information. Lives only inside the vault, never copied into a repo, a commit message,
or anything shareable without flagging it first.
