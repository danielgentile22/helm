---
name: voice-todo
description: Turn one spoken or typed sentence into todo writes on Daniel's vault, headless, and print one JSON line. Use for `/voice-todo <sentence>`, and for any sentence arriving from the dashboard's talk route that is a commitment ("Priya wants the explorer done by Friday"), a finished todo ("I sent the Acme resume"), a reschedule ("push that to Monday"), or a note or subtask about a todo ("add to the Lisbon todo that Sam wants the aisle seat").
---

# voice-todo

The `update-vault` skill's todo work, restated for a caller with nobody to ask. One sentence in, todo writes out, one JSON line on stdout.

Todos only. Never ask a question. Never scan projects, never reconcile the registry, never change a project's `status:`.

## Inputs

The prompt carries two lines:

```
now: 2026-09-22 21:04 Tuesday (America/New_York)
transcript: <what Daniel said, verbatim>
```

Typed as `/voice-todo <sentence>` the prompt has no `now:` line. Run `date "+%Y-%m-%d %H:%M %A"` and use that.

## Read set

The vault root is `$HELM_VAULT_ROOT`, `~/Vault` by default. Read from there. When `HELM_VAULT_ROOT` is set, the todo editor writes into that copy instead, which is how `skills/voice-todo/check_fixture.py` keeps the real vault untouched; the copy starts identical, so the reads still hold.

Open these, and no more than these:

- the four department notes, `Vault/Atlas/<D>/<D>.md` for Work, Projects, Chess and Life
- `Vault/Atlas/Projects/_registry.md`, then only the project notes the sentence names or could be naming
- only the people notes under `Vault/Atlas/People/` for a person the sentence names
- the todo rows that step 1 prints

Every extra note costs seconds and the whole turn has ninety. A sentence that names one project needs one project note.

Open a note under `Atlas/Decisions/`, `Atlas/Meetings/`, or anything tagged `#sensitive` only when the transcript names it. Legal, medical and financial material stays out of the turn.

## Steps

1. **List the todos.** `python3 runner/producers/capture.py --only todos --print`. Done when every open row's `id`, `dept`, `project`, `text` and markers are in front of you.
2. **Read the four department notes.** Done when you hold the `### ` directive headings that already exist under each note's `## Todos`.
3. **Resolve the names.** Match every project, person and "the thing X asked for" in the transcript against the project notes and people notes. Done when each name either resolves to a note or is written off as unresolved.
4. **Decide the operations.** Done when every commitment in the sentence maps to exactly one of `add`, `tick`, `untick`, `edit`, `note`, or a decline with a stated reason.
5. **Run the editor, once per operation.** Done when each run has printed its JSON and you hold its `line` and its `row.id`.
6. **Print the JSON line.** Done when the last non-empty line of stdout parses as the object below and the confirmation is twelve words or fewer.

## The editor

```
python3 runner/producers/todo_edit.py add <Dept> "<text>" [--project "<directive>"]
        [--due YYYY-MM-DD | --daily | --at "YYYY-MM-DD HH:MM"] [--done-when "<predicate>"]
python3 runner/producers/todo_edit.py tick <id>
python3 runner/producers/todo_edit.py untick <id>
python3 runner/producers/todo_edit.py edit <id> [--text "<new text>"]
        [--due YYYY-MM-DD | --daily | --at "YYYY-MM-DD HH:MM" | --undated]
        [--project "<directive>" | --unfile]
python3 runner/producers/todo_edit.py note <id> "<line>" [--sub]
```

`edit --text` changes the content id; the action carries the new one. `note --sub` writes a subtask box instead of a note line. Departments are fixed: to move a todo, add a fresh one in the right department and say so in the confirmation.

## Decision rules

Department, text, due date, predicate, kind and directive are the six numbered points under **Todo entry** in `skills/update-vault/SKILL.md`. Ticking is **Tick a todo** in that same file. Apply both as written, with one change: where they say to ask, decide instead.

Three rules of this skill's own:

1. Match the sentence against the listed todos before creating anything.
2. Prefer editing, ticking, or noting an existing row over creating a near duplicate of it.
3. When the reading is unclear, take the most likely one, act, and name the assumption inside the confirmation.

## Output

The last non-empty line of stdout is exactly one JSON object, with nothing after it:

```json
{"confirmation": "<at most twelve words>", "actions": [{"op": "add", "id": "<todo id>", "dept": "Projects", "row": "<the line the editor printed>"}]}
```

`row` is the editor's `line`. `id` is the editor's `row.id` for `add`, `edit` and `note`, and the id you passed for `tick` and `untick`.

Two cases write nothing and carry `"actions": []`:

- the sentence holds no todo. Confirmation exactly `Nothing to do there`.
- the operation cannot be carried out. Confirmation says why, in Daniel's terms, such as `I could not find a todo about Acme to tick`.

## Worked example

`now: 2026-09-22 21:04 Tuesday`, transcript `Priya wants the opening explorer finished and the share dialog copy fixed on Compiler by Friday`.

Two commitments, one project note (`Vault/Atlas/Projects/Compiler.md`), department Projects, the `Compiler` directive heading already exists, Friday is 2026-09-25.

```
python3 runner/producers/todo_edit.py add Projects "Compiler: finish the opening explorer" --project Compiler --due 2026-09-25
python3 runner/producers/todo_edit.py add Projects "Compiler: fix the share dialog copy" --project Compiler --due 2026-09-25
```

```json
{"confirmation": "Added two to Projects under Compiler, due Friday", "actions": [{"op": "add", "id": "3f9c1a20b7d4", "dept": "Projects", "row": "- [ ] Compiler: finish the opening explorer (due: 2026-09-25)"}, {"op": "add", "id": "b7d4e8813f9c", "dept": "Projects", "row": "- [ ] Compiler: fix the share dialog copy (due: 2026-09-25)"}]}
```
