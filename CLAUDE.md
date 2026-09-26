# helm

The public engine of a personal operating system. It knows nothing about its owner
until it reads a vault (`HELM_VAULT_ROOT`, default `~/Vault`), and it writes its own
state to `~/.helm` (`HELM_STATE`). Nothing personal ever lives in this repo. The words
used here are defined in `CONTEXT.md`, and the reasons are in `docs/adr/`.

Life sessions start in the vault, not here. Open this repo only to work on the engine.

## Rules

- **This repo is public, and history is forever.** Commit straight to `main`, no
  branches or pull requests (ADR 0032). The personal data guard in `.githooks/` is
  the only check before a leak: every clone runs `git config core.hooksPath .githooks`
  first, it needs the deny list at `~/.helm/guard/deny.txt`, and it fails closed
  without one. Never bypass it with `--no-verify`. If it blocks a line, change the
  line; add a path to `.githooks/paths` only when the path is engine.
- **Test data is fictional.** Fixtures, examples and docs use the demo vault's cast
  (Jordan, Priya, Sam, Alex Reed, Compiler, Keel, the Lisbon trip), never a real name,
  employer, place or plan.
- **Three homes.** Code here, knowledge in the vault, state in `~/.helm`. Nothing the
  software writes goes in the repo or the vault, except todo edits and routine reports
  the vault owns (ADR 0030).
- **Never Haiku, never effort above `high`.** `models.json` rejects both, and Helm
  Chat's picker offers neither.
- **Routines are host-portable.** No absolute paths to one machine. Plists are
  generated at install time.
- **The four departments are hardcoded** (Work, Projects, Chess, Life). That is
  intended (ADR 0028).
- Commit messages and docs use no em or en dashes as punctuation and carry no session
  links.

## Layout

| Path | What it is |
|---|---|
| `chat/` | Helm Chat, the phone chat surface. Node, Svelte 5. Port 8420 |
| `dashboard/` | The dashboard. Python standard library server, Svelte 5 build. Port 8642 |
| `runner/` | Routines, capture producers, checks, the launchd generator |
| `voice/` | The local speech server for talk. Port 3108 |
| `skills/` | `update-vault` and `voice-todo`, the two skills that operate a vault |
| `models.json` | Model and effort per skill and routine, plus the routine schedules |
| `demo-vault/` | A vault of fictional data |
| `archive/hud/` | The HELM 1 display. Not built or tested; `helm1-final` runs it |

## Run and verify

- Install or reinstall every job: `runner/install-routines.sh` (routines, dashboard,
  voice) and `chat/ops/install.sh` (Helm Chat). Labels are `com.helm.*`; logs are in
  `~/.helm/logs/`.
- Live probes: `curl 127.0.0.1:8420/`, `127.0.0.1:8642/api/health`,
  `127.0.0.1:3108/health`.
- Tests: `npm test` and `npm run typecheck` in `chat/`; `npm run check` in
  `dashboard/`; `python3 -m unittest discover -s <suite> -p 'test_*.py'` for
  `dashboard/server`, `runner` and `runner/producers`; `.githooks/test-guard.sh`.
  Point `HELM_STATE` and `HELM_VAULT_ROOT` at temporary folders when you run the
  Python suites. CI runs all of these on every push.
- Against the demo vault: `HELM_VAULT_ROOT=demo-vault python3 runner/producers/capture.py --print`.
  `skills/voice-todo/check_fixture.py` grades the voice-todo skill against a copy of it.
