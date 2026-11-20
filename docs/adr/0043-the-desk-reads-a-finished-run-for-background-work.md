# The desk reads a finished run's last items for background work

ADR 0042 has the desk read T3 through a read-only MCP session and never read a finished
thread. That missed a thread T3 itself shows as Working. An agent can start a long job
in the background, pass its task ID to `t3_background_wait` and end its turn. The run is
then `completed`, so the desk listed the thread as finished, while T3's sidebar kept it
in Working until the job ended and T3 woke the thread into a new run.

## What T3 does

Checked against T3 Code `0.1.10-nightly.20261111.4544`.

- T3 keeps a list of pending background tasks per thread. Its own status rule shows a
  `completed` thread as running while any of those tasks holds completion: a task the
  agent passed to `t3_background_wait`, a background subagent, or one of T3's own
  background tasks. A plain background command or a monitor does not hold it.
- That list is not in what the read-only session can read. `t3_thread_list` and
  `t3_thread_read` both report `status` as the run's status, and neither carries the
  tasks. The client's private `/ws` feed does, and ADR 0042 rules that out.
- The timeline does show the hold. `t3_thread_read` with `view: "activity"` returns the
  run's items, and a `t3_background_wait` call is a `dynamic_tool` item whose text names
  the tool, its input (`waiting: false` clears a wait) and its output (`matched`, the task
  IDs T3 accepted). A background subagent is a `subagent` item that stays `running`
  until it ends.

## Decision

For each top-level thread whose latest run completed in the last 12 hours, the desk
reads that run's last 12 timeline items once per run id, and caches the answer. If the
run's last `t3_background_wait` matched a task and was not cleared, or a `subagent` item
of that run is still active, the thread is listed under `running` with `background: true`
and `started` set to when the wait began. Everything else stays finished.

A delegated child is never read this way: reading a child's final result marks it
delivered (ADR 0042), so only threads with no parent are read, and the read stops at the
timeline. The thread list is scanned 50 finished threads deep, so a long hold is not
pushed out of view by newer threads finishing.

T3 has been asked to put the pending background tasks, or the status its own sidebar
uses, into `t3_thread_list` (pingdotgg/t3code discussion 39462). When it does, the desk
reads that field and the timeline read goes away.

## Considered options

- **Read the timeline tail of a finished top-level run.** Chosen. It uses only the
  read-only session, it costs one small read per finished run, and it ends at the right
  time in the common case, because T3 wakes the thread into a new run when the task ends.
- **Ask T3 for the field and wait.** The clean fix, and requested, but the desk is wrong
  until a T3 build ships it.
- **Read the `/ws` feed.** It has the tasks, but it is the client's private protocol and
  nightly builds change it. ADR 0042 rejected it, and that still holds.

## Consequences

- If T3 restarts during a wait, the background task dies with the process, and the desk
  keeps showing the thread in the background until the thread runs again or 12 hours
  pass since its run ended.
- T3's own background tasks (the third kind above) are not visible in the timeline, so a
  thread held only by one of those still shows as finished.
- The match is on text T3 writes into the timeline: the tool name, `waiting` and
  `matched`. A T3 build that changes that text turns the desk back into the ADR 0042
  behaviour, never into an error. The tests in `dashboard/server/test_desk.py` pin it.
