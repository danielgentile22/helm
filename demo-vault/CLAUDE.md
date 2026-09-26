# CLAUDE.md: standing instructions for this vault

> A demo vault of fictional data, so helm can run without anyone's real life in it.
> Point helm at it with `HELM_VAULT_ROOT=demo-vault`. A real vault has the same
> shape: this file, the five routers, `Atlas/`, `Inbox/` and `Archive/`.

## Who Jordan is

- A software engineer with a day job, a side project called Compiler with Priya,
  and a small business called Keel with [[Alex Reed]].
- Plays tournament chess and takes coaching. Partner: Sam.

## Directives

The three starred directives, in order. The stars live on the department notes.

1. Launch
2. Day job
3. Rating goal

## Departments

| Department | Router | Covers |
|---|---|---|
| Work | `WORK.md` | the day job, the launch, interview prep |
| Projects | `PROJECTS.md` | every repo, Compiler, Keel |
| Chess | `CHESS.md` | coaching, courses, tournaments |
| Life | `LIFE.md` | travel, errands, home, health |

`TOOLS.md` routes to skills and connectors. People, decisions and meetings sit under
`Atlas/` and belong to no department.

## Rules

- `Atlas/` is canon. `Inbox/` holds only routine output. `Archive/` is cold.
- Every pointer in a router is a real path. A stale pointer is worse than none.
- Todos live under `## Todos` on the four department notes, in the syntax that
  helm's runner README describes.
