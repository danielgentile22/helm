---
name: update-vault
description: Routine maintenance of Daniel's Obsidian vault at ~/Vault. Regenerates the projects registry from ~/Projects, reconciles drift (new, moved, deleted repos) against Atlas project notes, records project status changes Daniel reports ("I stopped on X", "I'm stuck on Y"), captures ideas as notes in Atlas/Ideas and changes their status ("add an idea", "remind me to", "I did X", "drop X"), and prunes inbox reports past retention. Use for /update-vault, "update vault", "sync projects", "what projects do I have", any status update about a project, or any sentence that is an idea, a commitment, or a finished or abandoned one.
---

# update-vault

Keep `Atlas/` in step with `~/Projects`. The scanner owns machine facts. Daniel owns status. Never let one overwrite the other.

Run from `~/Vault`. Follow the vault `CLAUDE.md` conventions (frontmatter, supersession callouts, no remote, commit at the end).

## Routing

| Invocation | Do |
|---|---|
| `/update-vault` or `/update-vault projects` | Scan, then reconcile drift (below) |
| `/update-vault status <project> <status> [why]` or a sentence like "I stopped on X" | Status change (below) |
| `/update-vault idea <sentence>`, "add an idea", or a sentence that is a commitment ("I need to book the Lisbon flights by Friday", "remind me to file the expense report") | Add an idea (below) |
| "I did X", "X is done", "drop X", "never mind X", "move X to Friday" | Change an idea (below) |
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

## Add an idea

The shape lives in `~/Projects/helm/docs/data-shapes.md` (Idea). Never write the note by hand. Decide from the sentence, then run the lever:

1. **Title**: the idea in Daniel's words, imperative, no date, no trailing period.
2. **Project** when the sentence names one: the `title` of its project note (Compiler, Keel). The department follows from the note's folder.
3. **Department** otherwise: Day job, the launch, interviews, resume → `Work`; a repo, helm, a skill → `Projects`; playing, coaching, rating → `Chess`; anything else → `Life`, which is also the default.
4. **Due date** as `YYYY-MM-DD`, only when the sentence sets one ("by Friday", "end of month"), derived against today's date.

```
python3 ~/Projects/helm/runner/producers/idea_edit.py add "<title>" [--project <title> | --department <D>] [--due YYYY-MM-DD] [--body "<more>"]
```

It writes `Atlas/Ideas/<created>-<slug>.md`, commits that one path, and prints one JSON line with the parsed idea. Report back the title, department or project, due date, and commit.

## Change an idea

Find the idea with `python3 ~/Projects/helm/runner/producers/idea_edit.py list --status open` by matching Daniel's words against the title, then use its id (the file name without `.md`):

```
python3 ~/Projects/helm/runner/producers/idea_edit.py status <id> done      # "I did X"
python3 ~/Projects/helm/runner/producers/idea_edit.py status <id> dropped   # "drop X"
python3 ~/Projects/helm/runner/producers/idea_edit.py status <id> open      # a misclick, or "X is back on"
python3 ~/Projects/helm/runner/producers/idea_edit.py due <id> YYYY-MM-DD|none
```

All are idempotent. Never delete an idea note. If more than one idea could match, show the candidates and ask.

Every commit subject names the action only (`Add an idea`, `Mark an idea done`, `Drop an idea`), never the idea's text: titles carry amounts and phone numbers, and the vault history keeps them.

## Finish

Rerun the scan, then commit everything with a message that names what changed. The vault has no remote; do not add one.
