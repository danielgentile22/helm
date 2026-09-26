"""todo_edit tests against a temp vault. No git and no commits: these cover the note edit.

    python3 -m unittest runner/producers/test_todo_edit.py
"""
from __future__ import annotations

import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parent)]

import common  # noqa: E402
import todo_edit  # noqa: E402
from sources import todos  # noqa: E402

NOTE_BODY = """# Chess

## Todos

- [ ] enter the October open
- [x] pay the club dues

## Not here

nothing
"""


class AddTest(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.vault = Path(tmp.name) / "Vault"
        self.note = self.vault / "Atlas" / "Chess" / "Chess.md"
        self.note.parent.mkdir(parents=True)
        self.note.write_text(NOTE_BODY)
        self.addCleanup(setattr, common, "VAULT", common.VAULT)
        common.VAULT = self.vault

    def test_a_new_todo_lands_under_the_last_box(self) -> None:
        _, line = todo_edit.add("Chess", "book the Thursday lesson", None, None)
        self.assertEqual(line, "- [ ] book the Thursday lesson")
        self.assertIn("- [x] pay the club dues\n- [ ] book the Thursday lesson", self.note.read_text())

    def test_a_text_already_on_the_note_is_refused(self) -> None:
        for text in ("enter the October open", "pay the club dues", "  enter   the October open  "):
            with self.subTest(text=text):
                with self.assertRaises(todo_edit.TodoEditError) as caught:
                    todo_edit.add("Chess", text, None, None)
                self.assertIn("same text share one content id", str(caught.exception))
        self.assertEqual(self.note.read_text(), NOTE_BODY)

    def test_ticking_writes_the_line_it_matched_and_leaves_the_rest_alone(self) -> None:
        self.addCleanup(setattr, common, "ENGINE", common.ENGINE)
        common.ENGINE = self.vault.parent
        row_id = common.content_id(str(self.note.relative_to(self.vault.parent)), "enter the October open")

        note, line, changed = todo_edit.set_done(row_id, True)
        self.assertEqual((note, line, changed), (self.note, "- [x] enter the October open", True))
        self.assertEqual(self.note.read_text(), NOTE_BODY.replace("- [ ] enter", "- [x] enter"))

        self.assertEqual(todo_edit.set_done(row_id, True)[2], False)
        self.assertEqual(todo_edit.set_done(row_id, False)[2], True)
        self.assertEqual(self.note.read_text(), NOTE_BODY)

    def test_the_due_date_and_the_predicate_are_not_part_of_the_text(self) -> None:
        todo_edit.add("Chess", "enter the November open", "2026-11-01", None)
        with self.assertRaises(todo_edit.TodoEditError):
            todo_edit.add("Chess", "enter the November open", None, None)


if __name__ == "__main__":
    unittest.main()


class KindsTest(AddTest):
    def test_a_project_todo_lands_under_its_directive_heading(self) -> None:
        todo_edit.add("Chess", "analyse both games", None, None, project="Coaching")
        todo_edit.add("Chess", "twenty minutes of tactics", None, None, project="Coaching", daily=True)
        todo_edit.add("Chess", "club night", None, None, at="2026-09-22 19:30")
        text = self.note.read_text()
        self.assertIn("- [x] pay the club dues\n- [ ] club night (at: 2026-09-22 19:30)\n\n### Coaching\n\n"
                      "- [ ] analyse both games\n- [ ] twenty minutes of tactics (daily)\n\n## Not here", text)

    def test_a_starred_heading_is_found_by_its_name(self) -> None:
        """A star is a rank on the heading, not part of the name, so filing under the
        directive reuses the starred heading rather than coining a second one."""
        todo_edit.add("Chess", "analyse both games", None, None, project="Coaching")
        self.note.write_text(self.note.read_text().replace("### Coaching\n", "### Coaching ★3\n"))
        todo_edit.add("Chess", "review the endgame", None, None, project="Coaching")
        text = self.note.read_text()
        self.assertEqual(text.count("### Coaching"), 1)
        self.assertIn("### Coaching ★3\n\n- [ ] analyse both games\n- [ ] review the endgame\n", text)

    def test_a_todo_after_a_starred_heading_is_still_found(self) -> None:
        """collect() reports a starred heading as a directive row with no id; looking a todo
        up by id must step over it rather than raise KeyError after the write has landed."""
        self.addCleanup(setattr, common, "ENGINE", common.ENGINE)
        common.ENGINE = self.vault.parent
        todo_edit.add("Chess", "analyse both games", None, None, project="Coaching")
        self.note.write_text(self.note.read_text().replace("### Coaching\n", "### Coaching ★3\n"))
        row_id = common.content_id(str(self.note.relative_to(self.vault.parent)), "analyse both games")
        self.assertEqual(todo_edit.row_for(row_id)["text"], "analyse both games")
        self.assertIsNone(todo_edit.row_for("no such id"))

    def test_a_daily_is_done_by_date_and_never_ticked(self) -> None:
        self.addCleanup(setattr, common, "ENGINE", common.ENGINE)
        common.ENGINE = self.vault.parent
        todo_edit.add("Chess", "tactics", None, None, daily=True)
        row_id = common.content_id(str(self.note.relative_to(self.vault.parent)), "tactics")
        _, line, changed = todo_edit.set_done(row_id, True, today="2026-09-22")
        self.assertEqual((line, changed), ("- [ ] tactics (daily) (done: 2026-09-22)", True))
        _, line, changed = todo_edit.set_done(row_id, True, today="2026-09-22")
        self.assertFalse(changed)
        _, line, changed = todo_edit.set_done(row_id, True, today="2026-09-23")
        self.assertEqual((line, changed), ("- [ ] tactics (daily) (done: 2026-09-23)", True))
        _, line, changed = todo_edit.set_done(row_id, False, today="2026-09-23")
        self.assertEqual((line, changed), ("- [ ] tactics (daily)", True))

    def test_markers_are_not_part_of_the_text(self) -> None:
        for line, text in (("- [ ] a (daily) (done: 2026-09-01)", "a"), ("- [ ] b (at: 2026-09-24 19:00)", "b"),
                           ("- [ ] (daily) c", "c")):
            self.assertEqual(todos.parse_todo_line(line).text, text)


EDIT_BODY = """# Chess

## Todos

- [ ] renew the club membership

### Coaching

- [ ] review both games (due: 2026-09-25)
  Bring the scoresheets.
  - [ ] scan them
  - [x] pay Alex
- [ ] twenty minutes of tactics (daily) (done: 2026-09-21)

### Tournaments

- [ ] enter the October open done-when: file exists entry.txt

## Not here

nothing
"""


class EditTest(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.vault = Path(tmp.name) / "Vault"
        self.note = self.vault / "Atlas" / "Chess" / "Chess.md"
        self.note.parent.mkdir(parents=True)
        self.note.write_text(EDIT_BODY)
        self.addCleanup(setattr, common, "VAULT", common.VAULT)
        common.VAULT = self.vault

    def id_of(self, text: str) -> str:
        """No common.ENGINE patch above: a vault somewhere else keeps the same ids."""
        return common.content_id(str(self.note.relative_to(self.vault.parent)), text)

    def test_each_field_changes_on_its_own(self) -> None:
        _, line, changed, text = todo_edit.edit(self.id_of("review both games"), text="review all three games")
        self.assertEqual((line, changed, text),
                         ("- [ ] review all three games (due: 2026-09-25)", True, "review all three games"))

        _, line, _, _ = todo_edit.edit(self.id_of("review all three games"),
                                       schedule=todo_edit.Schedule("event", "2026-09-26 19:00"))
        self.assertEqual(line, "- [ ] review all three games (at: 2026-09-26 19:00)")

        _, line, _, _ = todo_edit.edit(self.id_of("review all three games"), schedule=todo_edit.Schedule("todo"))
        self.assertEqual(line, "- [ ] review all three games")

    def test_the_done_when_tail_and_a_daily_done_marker_are_carried_over(self) -> None:
        _, line, _, _ = todo_edit.edit(self.id_of("enter the October open"), text="enter the November open")
        self.assertEqual(line, "- [ ] enter the November open done-when: file exists entry.txt")

        _, line, _, _ = todo_edit.edit(self.id_of("twenty minutes of tactics"), text="thirty minutes of tactics")
        self.assertEqual(line, "- [ ] thirty minutes of tactics (daily) (done: 2026-09-21)")

    def test_a_marker_change_keeps_the_id(self) -> None:
        row_id = self.id_of("renew the club membership")
        _, line, changed, text = todo_edit.edit(row_id, schedule=todo_edit.Schedule("todo", "2026-10-01"))
        self.assertEqual((line, changed), ("- [ ] renew the club membership (due: 2026-10-01)", True))
        self.assertEqual(self.id_of(text), row_id)
        todo_edit.edit(row_id, schedule=todo_edit.Schedule("daily"))
        self.assertIn("- [ ] renew the club membership (daily)", self.note.read_text())

    def test_a_directive_change_moves_the_notes_and_the_subtasks_too(self) -> None:
        todo_edit.edit(self.id_of("review both games"), project="Tournaments")
        self.assertIn("### Tournaments\n\n"
                      "- [ ] enter the October open done-when: file exists entry.txt\n"
                      "- [ ] review both games (due: 2026-09-25)\n"
                      "  Bring the scoresheets.\n"
                      "  - [ ] scan them\n"
                      "  - [x] pay Alex\n\n## Not here", self.note.read_text())
        self.assertIn("### Coaching\n\n- [ ] twenty minutes of tactics", self.note.read_text())

    def test_unfiling_moves_the_block_before_the_first_directive(self) -> None:
        todo_edit.edit(self.id_of("review both games"), project=None)
        self.assertIn("- [ ] renew the club membership\n"
                      "- [ ] review both games (due: 2026-09-25)\n"
                      "  Bring the scoresheets.\n"
                      "  - [ ] scan them\n"
                      "  - [x] pay Alex\n\n### Coaching", self.note.read_text())

    def test_the_same_values_are_not_written(self) -> None:
        _, line, changed, _ = todo_edit.edit(self.id_of("review both games"), text="review both games",
                                             schedule=todo_edit.Schedule("todo", "2026-09-25"), project="Coaching")
        self.assertEqual((line, changed), ("- [ ] review both games (due: 2026-09-25)", False))
        _, _, changed, _ = todo_edit.edit(self.id_of("twenty minutes of tactics"),
                                          schedule=todo_edit.Schedule("daily"))
        self.assertFalse(changed)
        self.assertEqual(self.note.read_text(), EDIT_BODY)

    def test_a_text_already_on_the_note_is_refused(self) -> None:
        with self.assertRaises(todo_edit.TodoEditError) as caught:
            todo_edit.edit(self.id_of("review both games"), text="renew the club membership")
        self.assertIn("same text share one content id", str(caught.exception))
        self.assertEqual(self.note.read_text(), EDIT_BODY)

    def test_an_unknown_id_is_an_error(self) -> None:
        for call in (lambda: todo_edit.edit("0" * 12, text="whatever"),
                     lambda: todo_edit.annotate("0" * 12, "whatever")):
            with self.assertRaises(todo_edit.TodoEditError) as caught:
                call()
            self.assertIn("no todo with id", str(caught.exception))


class NoteTest(EditTest):
    def test_a_note_lands_after_the_children_the_todo_already_has(self) -> None:
        note, line, text = todo_edit.annotate(self.id_of("review both games"), "  Ask about  the French. ")
        self.assertEqual((note, line, text), (self.note, "  Ask about the French.", "review both games"))
        self.assertIn("  - [x] pay Alex\n  Ask about the French.\n- [ ] twenty minutes", self.note.read_text())

    def test_a_subtask_lands_as_a_box(self) -> None:
        _, line, _ = todo_edit.annotate(self.id_of("review both games"), "print the games", sub=True)
        self.assertEqual(line, "  - [ ] print the games")
        self.assertIn("  - [x] pay Alex\n  - [ ] print the games\n", self.note.read_text())

    def test_a_line_the_todo_already_has_is_refused(self) -> None:
        for text, sub in (("Bring   the scoresheets.", False), ("scan them", True), ("pay Alex", True)):
            with self.subTest(text=text):
                with self.assertRaises(todo_edit.TodoEditError) as caught:
                    todo_edit.annotate(self.id_of("review both games"), text, sub=sub)
                self.assertIn("already has this line", str(caught.exception))
        self.assertEqual(self.note.read_text(), EDIT_BODY)

    def test_a_note_under_one_todo_is_not_a_duplicate_under_another(self) -> None:
        todo_edit.annotate(self.id_of("renew the club membership"), "Bring the scoresheets.")
        self.assertIn("- [ ] renew the club membership\n  Bring the scoresheets.\n", self.note.read_text())


class MessageTest(unittest.TestCase):
    def test_the_commit_subject_names_the_department_and_the_todo(self) -> None:
        note = Path("Vault/Atlas/Chess/Chess.md")
        self.assertEqual(todo_edit.edit_message(note, "review all three games"),
                         "Edit a Chess todo: review all three games")
        self.assertEqual(todo_edit.note_message(note, "review both games", False),
                         "Note on a Chess todo: review both games")
        self.assertEqual(todo_edit.note_message(note, "review both games", True),
                         "Add a subtask to a Chess todo: review both games")


class CliTest(EditTest):
    def run_cli(self, argv: list[str]) -> tuple[int, dict | None]:
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            code = todo_edit.main(argv)
        return code, (json.loads(out.getvalue()) if out.getvalue().strip() else None)

    def test_edit_through_the_cli(self) -> None:
        code, result = self.run_cli(["edit", self.id_of("review both games"), "--text", "review all three games",
                                     "--undated", "--unfile", "--no-commit"])
        self.assertEqual(code, 0)
        self.assertEqual((result["commit"], result["changed"], result["line"]),
                         (None, True, "- [ ] review all three games"))
        self.assertEqual(result["row"]["id"], self.id_of("review all three games"))
        self.assertIsNone(result["row"]["project"])

    def test_note_through_the_cli(self) -> None:
        code, result = self.run_cli(["note", self.id_of("review both games"), "print the games",
                                     "--sub", "--no-commit"])
        self.assertEqual(code, 0)
        self.assertEqual((result["commit"], result["changed"], result["line"]),
                         (None, True, "  - [ ] print the games"))
        self.assertEqual([s["text"] for s in result["row"]["subs"]], ["scan them", "pay Alex", "print the games"])

    def test_an_unknown_id_exits_two(self) -> None:
        for argv in (["edit", "0" * 12, "--daily", "--no-commit"], ["note", "0" * 12, "hi", "--no-commit"]):
            self.assertEqual(self.run_cli(argv)[0], 2)
