# Helm is a project manager over the vault

Supersedes ADR 0033 and the hero and pressure map records (0017, 0018, 0019, 0023,
0024, 0026), and supersedes in part ADR 0014 and ADR 0027 (todos), ADR 0020 (what
capture feeds) and ADR 0025 (the microphone).

By November 2026 the owner reached the vault from every device through T3 Code, a
coding agent app with its own phone client. Helm Chat, talk and the pressure map had
no use after late September, and the department todo lists were mostly unticked: about
six real ticks in eleven weeks, one due date, and a projects list that copied GitHub
issue numbers. What nothing else gave the owner was one place to see the projects,
throw ideas, watch the background jobs and look up the devices they own. Helm is now
that place. Conversation stays in T3 Code.

Helm Chat, the voice server, talk, the tier benchmark and the pressure map interface
were deleted. The dashboard server, its passkey door and the runner stay; the
interface is rebuilt as four tabs.

| Tab | Reads | Writes |
|---|---|---|
| Projects | project notes in the vault, each project's tracker, its repos | nothing |
| Ideas | idea notes in the vault | new ideas, status changes, promotion to an issue |
| Background | `models.json`, launchd, `~/.helm/status`, `~/.helm/logs` | run now, pause, resume |
| Devices | device notes in the vault, live tailnet presence | nothing |

## Considered options

- **A todo app with its own interface and nothing else.** Rejected: the todo history
  shows the owner does not work from a dated list, and calendar reminders already live
  in their calendar app.
- **Retire helm.** Rejected: the unattended routines are the one part with no
  substitute, and they had nowhere to be watched.
- **Keep Helm Chat as the shell (ADR 0033).** Rejected: T3 Code does the same job on
  the phone, maintained by someone else.

## Consequences

- **An idea replaces the todo.** One note per idea in `Atlas/Ideas/`, so a capture
  from the phone, an agent and a routine never edit the same file. An idea with a due
  date is what a todo was. The department todo lists are migrated into ideas and
  retire, and so does starred pull on todos. Directives stay.
- **Ideas live outside the four department folders.** That breaks the rule that Atlas
  holds only departments, on purpose: a capture box that asks for a department first
  gets used less. An idea names its department in frontmatter, derived from its
  project when it has one.
- **A project names its tracker.** GitHub Issues by default; a workspace with a local
  tracker (`.scratch/<slug>/issues/`) uses only that and ignores its repos' GitHub
  Issues. A project can show only the owner's own branches and pull requests, for
  repos where someone else does most of the pushing.
- **Promotion writes to the project's tracker.** A GitHub issue for a GitHub project,
  a new numbered file for a local tracker. The idea keeps a link to it and is marked
  promoted.
- **Devices are vault notes with frontmatter,** one note per device. The engine joins
  them to the tailnet by host name for online status. Nothing about a device is stored
  in State except that live join.
- **Capture keeps running** but now produces what the Projects tab reads: tracker
  counts, open pull requests, last commit and CI per project. GitHub is called from the
  routine, never from a page load.
- **The dashboard owns nothing (ADR 0015) still holds.** Every write lands in the
  vault, a tracker, or launchd. State keeps only caches and run records.
