---
name: update-vault
description: Routine maintenance of Daniel's Obsidian vault at ~/Vault. Regenerates the projects registry from ~/Projects, reconciles drift (new, moved, deleted repos) against Atlas project notes, records project status changes Daniel reports ("I stopped on X", "I'm stuck on Y"), adds and ticks todos on the department notes ("add a todo", "remind me to", "I did X"), and prunes inbox reports past retention. Use for /update-vault, "update vault", "sync projects", "what projects do I have", any status update about a project, or any sentence that is a todo or a finished todo.
---

# update-vault

Keep `Atlas/` in step with `~/Projects`. The scanner owns machine facts. Daniel owns status. Never let one overwrite the other.

Run from `~/Vault`. Follow the vault `CLAUDE.md` conventions (frontmatter, supersession callouts, no remote, commit at the end).

## Routing

| Invocation | Do |
|---|---|
| `/update-vault` or `/update-vault projects` | Scan, then reconcile drift (below) |
| `/update-vault status <project> <status> [why]` or a sentence like "I stopped on X" | Status change (below) |
| `/update-vault todo <sentence>`, or a sentence that is a commitment ("I need to book the Lisbon flights by Friday", "remind me to file the expense report") | Todo entry (below) |
| "I did X", "X is done", "tick X" | Tick a todo (below) |
| `/update-vault inbox` | Prune `Inbox/` per the retention rules in the vault's `CLAUDE.md`: `Inbox/runs/integrity/` 30 days, `Inbox/helm2-phone-chats/` 30 days. List what would go, delete on Daniel's yes |
| `/update-vault all` | All three, in that order |

## Scan

```
python3 ~/.claude/skills/update-vault/scan_projects.py --json
```

It rewrites `Atlas/Projects/_registry.md` (generated, never hand-edit) and prints drift as JSON. Add `--metrics` only when a scheduled run should feed the dashboard; on-demand runs skip it so `~/.helm/metrics/metrics.csv` does not fill with duplicates.

## Reconcile drift

Present the four buckets in one short table, then act. Lead with the recommendation per bucket; Daniel answers with letters.

- **Unnoted repos.** For each, offer A create a stub project note, B mark it as not a project (tooling, scratch, a fork), or C skip. A stub note has `type: project`, `title`, `updated`, `tags`, `status`, `repo`, and one line from the repo README or last commit. Non-projects go into `Atlas/Projects/_registry-ignore.md`, one `~/Projects/...` path per line; the scanner drops them.
- **Missing repos.** The folder at `repo:` is gone. Offer A it moved (set the new `repo:`), or B it is dead (set `status: archived`, add a `> [!note] Superseded YYYY-MM-DD` callout naming the old path, and move the note to `Atlas/_archive/`; safe here only because no folder remains to re-detect).
- **Registered with a folder in `archive/`** but note status not archived. Recommend setting `status: archived`; moving the folder is Daniel's signal. Keep the note in `Atlas/Projects/`. Never move a note whose folder still exists into `Atlas/_archive/`: the scanner skips that directory, so its repo would reappear as unnoted every run. The home page already filters on `status = "active"`.
- **Registered, status active, no commit in 90 days.** Ask whether it is paused or abandoned. Do not change status unprompted.

Rerun the scan after edits so the registry reflects the result.

## Status change

Statuses are `active`, `dormant`, `shipped`, `archived` (schema in `CLAUDE.md`). Map Daniel's words: stopped or paused → `dormant`; stuck → stays `active`, add a dated bullet with the blocker; done → `shipped`; abandoned → `archived`. Edit the note's `status:`, bump `updated:`, and append a dated bullet under a `## Log` section (create it if absent) with his reason in his words. Never rewrite earlier bullets.

## Todo entry

The syntax and the row contract live in `~/Projects/helm/runner/README.md` (Todo syntax) and `runner/producers/sources/todos.py`. Do not write the line by hand. Decide six things from the sentence, then run the lever:

1. **Department** from the subject: Day job, the launch, interviews, resume → `Work`; a repo, helm, a skill → `Projects`; playing, coaching, the club, rating → `Chess`; everything else → `Life`. When it is genuinely unclear, ask.
2. **Text**: the commitment in Daniel's words, imperative, no date, no trailing period. Keep a project name as a prefix (`Compiler: ...`) when the sentence names one.
3. **Due date** as `YYYY-MM-DD`, derived from the sentence against today's date ("by Friday", "before the tournament", "end of month"). No date is fine; the row still has an age from the commit.
4. **Predicate**, only when one of the four shapes fits exactly: `pr merged <owner/repo>#<n>`, `tree clean <path>`, `metric <name> >= <value>`, `file exists <path>`. Most todos have none.
5. **Kind**. A thing done every day ("every morning", "daily") is `--daily` and carries no date. A thing that happens at a moment (a session, an appointment, a call) is `--at "YYYY-MM-DD HH:MM"`. Everything else is a plain todo, dated or not.
6. **Directive** with `--project`: the `### <directive>` heading the todo belongs under in the note's Todos section (Launch, Day job, Coaching, Lisbon trip). Reuse a heading that exists; coin one only when the sentence clearly names a thread of work with more than one todo in it. A one-off stays unfiled.

```
python3 ~/Projects/helm/runner/producers/todo_edit.py add <Dept> "<text>" [--project "<directive>"] [--due YYYY-MM-DD | --daily | --at "YYYY-MM-DD HH:MM"] [--done-when "<predicate>"]
```

It appends under the note's `## Todos` heading (under the directive's `### ` heading when given, creating it), validates with `parse_todo_line`, commits in the vault repo with explicit paths, and prints the row as `capture.py --only todos --print` shows it. Report that row back: department, text, due, id, and the commit. The five todos written on 2026-09-16 on the four department notes are the reference examples.

## Tick a todo

Never delete a todo line. Find the id in `~/.helm/status/agenda.json` (or `python3 ~/Projects/helm/runner/producers/capture.py --only todos --print`) by matching Daniel's words against `text`, then:

```
python3 ~/Projects/helm/runner/producers/todo_edit.py tick <id>
```

It flips `[ ]` to `[x]` on the line with that content id and commits. A daily is never ticked: it gets `(done: today)` on its line instead, and untick takes that off. `untick <id>` reverses a misclick. Both are idempotent. If more than one todo could match, show the candidates and ask.

## Finish

Rerun the scan, then commit everything with a message that names what changed. The vault has no remote; do not add one.
