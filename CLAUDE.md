# helm

The public engine behind a personal operating system. It knows nothing about its
user until it reads a vault. Everything personal lives in that vault, never here.

This repo is mid-merge: the engine is arriving from a private repo in steps, and a
full `CLAUDE.md` and `CONTEXT.md` land when it is done.

## Rules

- **This repo is public.** Commit straight to `main`, no branches or pull requests.
  The personal data guard in `.githooks/` is the only check before a leak, so every
  clone runs `git config core.hooksPath .githooks` first. It needs a deny list at
  `~/.helm/guard/deny.txt` and fails closed without one. Never bypass it with
  `--no-verify`.
- Commit messages and docs use no em or en dashes as punctuation, and carry no
  session links.

## What is here

- `chat/` is Helm Chat, the phone chat surface. Tests: `npm test` and
  `npm run typecheck` inside `chat/`. Setup in `chat/docs/SETUP.md`.
- `archive/hud/` is the HELM 1 heads-up display. Not built or tested. The tag
  `helm1-final` runs HELM 1 as it last worked.
- `demo-vault/` is a vault of fictional data.
- `docs/decisions/` holds the architecture decision records.
