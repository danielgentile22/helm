# The desk reads T3 through a read-only MCP session

The desk view (a spare phone kept on beside the Mac) lists T3 Code threads: the ones
running, the ones waiting on the owner, and the last few that finished. T3 keeps that
state in its own database, and the dashboard needs a way to read it that T3 supports,
that cannot change anything, and that keeps T3's credentials where T3 keeps them.

## What the spike found

Checked against T3 Code `0.1.10-nightly.20261111`.

- **The database is not an option.** `~/.t3/userdata/server-owner.sqlite` is locked while
  T3 runs, and `statev2.sqlite` holds empty projection tables.
- **The server's address** is in `~/.t3/userdata/server-runtime.json` (`origin`, `port`,
  `pid`). It changes when T3 restarts, so it is read on every connection.
- **The API is MCP.** The server answers MCP over streamable HTTP at `POST <origin>/mcp`,
  protocol version `2025-06-18`. It is the same endpoint T3's own `t3 thread list` command
  uses: that command signs in as a short lived MCP client, calls the tool `t3_thread_list`,
  and revokes the session when it ends. The desktop client itself talks over a WebSocket
  RPC at `/ws`, which is internal and not used here.
- **Auth is a bearer session, and a read-only one exists.** `/mcp` accepts only sessions
  with the subject `mcp-client`. T3 has an access level named `read-only` for MCP clients,
  whose only scope is `orchestration:read`. The supported way to mint one from a script
  is T3's own CLI:

  ```
  ~/.t3/bin/t3 auth session issue --subject mcp-client --scope orchestration:read \
      --ttl 1h --label "helm desk" --json
  ```

  It prints `sessionId`, `token`, `scopes` and `expiresAt`, and `t3 auth session list`
  shows it with its label. A write tool called with that session is refused:
  `capability_denied`, "this MCP client was approved for read-only access". A bearer
  session without the `mcp-client` subject is refused at `/mcp` with a 401.
- **The listing.** `t3_thread_list` (annotated read-only and idempotent) takes
  `allProjects`, `statuses`, `includeSubagents`, `limit` (up to 100) and `cursor`, and
  answers `structuredContent: {threads, nextCursor, total}`. Each thread has `threadId`,
  `projectId`, `title`, `status`, `latestRunId`, `createdAt`, `updatedAt`, `settled`,
  `snoozed` and more. `status` is `idle` (no run yet) or a run status: `preparing`,
  `queued`, `starting`, `running`, `waiting` (on the owner: an approval or an answer),
  `completed`, `interrupted`, `failed`, `cancelled`, `rolled_back`.
- **Projects.** `t3_project_list` answers `{projects: [{id, title, workspaceRoot}], nextCursor}`.
- **Run times.** The listing has no run start. `t3_thread_read` answers `recentRuns` with
  `requestedAt`, `startedAt` and `completedAt`. Its description warns that reading a
  child thread's final result marks it delivered, so the desk calls it only for threads
  that are running or waiting (they have no final result), with one item, one run and one
  character per item, and only once per run id.

## Decision

The dashboard server issues a read-only MCP session through T3's CLI the first time the
desk asks for threads, keeps the token in memory only, and issues a new one when it is
an hour old or the server answers 401. It never writes the token to disk, a log or an
example file. It calls only `t3_thread_list`, `t3_project_list` and the narrow
`t3_thread_read` above, and answers `GET /api/t3/threads` from a cache a few seconds old
so several open pages cost T3 one read. Thread titles appear in the response and nowhere
else: log lines name the route and an error's type, never a title.

## Considered options

- **A read-only MCP session.** Chosen. It is the access level T3 built for outside
  agents that only read, the server enforces it on every tool, and the session is
  visible and revocable in `t3 auth session list`.
- **Run `t3 thread list --json`.** It works, but it lists one project per call, and each
  call signs in with full access, which the desk does not need.
- **The `/ws` RPC with an `orchestration:read` bearer.** Least privilege too, but it is
  the client's private protocol, and nightly builds change it without notice.
- **Read the SQLite files.** Locked or empty, as above.

## Consequences

- Issuing a session writes one row to T3's own session table. That is T3's auth state,
  never a thread's, and each session expires an hour after it was issued.
- The desk depends on T3's CLI living at `~/.t3/bin/t3` (or `HELM_T3_CLI`) and on the
  MCP tool names above. When T3 is not running, or answers something unexpected, the
  route says so in `state` and `detail`, and the desk shows that in place of the list.
- A nightly T3 build can rename a tool or a field. The parsing is in one module,
  `dashboard/server/t3.py`, and its tests pin the shapes above.
