# HELM

Voice-controlled, file-backed personal heads-up display. All state is plain
files under the vault; the HUD renders them, and mutations happen either
directly (small authed API routes) or through runner skills.

## Language

**TODO**:
A job-search checklist item — one checkbox line in `jobs/todos.md` in the
vault. Created and checked off from the HUD's Jobs tab or by editing the file
in Obsidian; both act on the same file.
_Avoid_: task (taken — see Task), action item

**Task**:
A Morphy work item — a card on the shared Notion board, created via the
`morphy-task-add` skill. Never stored in the vault; the vault holds only a
read cache of the board.
_Avoid_: todo

**Atlas note**:
A Daniel-curated markdown note under the vault's `Atlas/`. Machine-read-only:
the HUD renders Atlas notes but never writes them. The TODO list is NOT an
Atlas note precisely so it can be machine-written.

**Seed**:
The one-time copy (2026-07-03) of the Interview Readiness plan's checkboxes
into `jobs/todos.md`. After the seed, `jobs/todos.md` is canonical for
tracking state; `Atlas/Projects/Interview Readiness.md` remains the narrative
plan and its checkboxes are no longer authoritative.

## Example dialogue

> **Dev:** Daniel checked off "Deploy REDACTED-REPO" on his phone — do we
> update Interview Readiness.md?
> **Domain expert:** No. That checkbox lives in the TODO list; the Atlas note
> is just the story of the plan. Nothing syncs back.
> **Dev:** And "add a task: email the recruiter"?
> **Domain expert:** Careful — a *Task* would land on the Morphy Notion
> board. Emailing a recruiter is a job-search *TODO*; it appends to
> `jobs/todos.md`.
