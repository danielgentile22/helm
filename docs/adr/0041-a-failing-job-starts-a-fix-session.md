# A failing job starts a fix session

An alert (ADR 0039) tells the owner that a routine failed, went quiet, or that a service is
down. Then someone has to open the logs, read the status file, look at what changed since
it last worked, fix it, and rerun it. When the owner is away for the day, that waits, and
a broken capture or backup stays broken until evening.

ADR 0039 rejected a model for sending pushes, because a push is a fact the engine already
has. Fixing the job is the case it left out: reading unfamiliar logs and deciding what is
wrong is judgment, which is what a model is for.

So after an evaluation pushes, every visible `routine:`, `quiet:` and `service:` alert
with no session yet starts one. The session gets a brief built from what the engine
already holds: what the job does and why from `models.json`, its status file, the last
lines of its logs, launchd's view of it, and the commits in its owning project since it
last succeeded. It is told to find the root cause, fix it, test it under the owning repo's
CLAUDE.md, commit, rerun the job and confirm the alert closes. It stops and waits for the
owner before deleting data, rewriting vault history or touching a credential. CI and idea
alerts never start one: a red pull request belongs to whoever is working on it, and a due
idea is the owner's own.

Model and effort live in `models.json` under `on_alert.triage`, opus at high, checked
against the policy like every other entry (ADR 0011).

## Considered options

- **A T3 thread.** Chosen. The thread shows up where the owner already works, on the Mac
  and the phone, so the session can be read, steered or stopped from either. The alert
  carries the thread's link and the dashboard shows it under the alert.
- **A headless `claude -p` only.** Kept as the fallback for when T3 is not running or does
  not answer within a minute. It runs detached in the owning project, and its output goes
  to a log in the ledger, which the alert names instead of a link.
- **A report in the vault only.** Rejected: the integrity check already writes one, and
  someone still has to act on it.

## Consequences

- It is opt-in. Nothing starts unless `~/.helm/triage/enabled` exists. The tests, CI and
  the backup tests run routine scripts against temporary state folders, and the integrity
  check runs the test suites every morning on the real machine; none of them may start a
  session.
- The ledger at `~/.helm/triage/<day>/` is the only record of what started, and it sets
  the limits: one session per alert key per local day, and three a day in all. An alert
  that reopens with a new fingerprint the same day gets the same session back.
- A quiet or service alert starts a session only once it has held for five minutes, which
  on capture's half-hour beat means the next evaluation. A service restarting on purpose, or
  a Mac waking, otherwise looks like an outage for a moment.
- A claim is written before the session starts and removed if the start fails, so a crash
  costs at most one session and never starts a second one for the same key.
- A start that fails never fails the evaluation, the same rule as a push.
- The push payload is unchanged: title, tab and count. The session link stays in the alert
  file and on the dashboard.
- T3's command line has no effort flag, so a T3 thread runs at the provider's default
  effort. The headless fallback passes the effort from `models.json`.
- Each routine now evaluates alerts on exit, after it prints its output, so the log tail in
  the brief includes the run that failed.
