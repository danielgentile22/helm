# Changelog

## Unreleased

- New scheduled skill `atlas-distill` (PRD B): Sundays 16:00 (before the
  weekly review) the runner distills the recent raw layer (daily notes,
  voice, chats, reports) into Atlas — dated fact bullets auto-appended to
  existing `Atlas/Areas/` notes (append-only, dedupe-checked), while new
  Decision records, new Areas, and canon contradictions land as drafts in
  an `inbox/reports/atlas-distill/` report flagged `pending-review`.
  `#sensitive`, `system/`, `archive/`, and Morphy board files excluded.
- Docs & repo hygiene (issue #44): machine record (`.helm-config.json`)
  now lists all 9 skills and is the authoritative launchd inventory, with
  every installed plist versioned in `scripts/`; CLAUDE.md / README /
  `docs/architecture.html` updated to the post-v2 tabbed shell (dead
  `components/HUD.tsx` pointers, demo modes, `.boot-stagger`, stale agent
  counts removed); one shared `~/.claude/.env` parser for the runner and
  queue scripts (`runner/env.js`), key rule aligned with `lib/homeEnv.ts`;
  version single-sourced from package.json (heartbeat reads it, `VERSION`
  file removed); untracked `morphy-hud.png` (1.2 MB).
- Docs cleanup: removed the stale `docs/how-it-works.html` historical
  snapshot (superseded by `docs/architecture.html`) and moved the internal
  `PRD-helm-improvements.md` out of the repo into the vault.

## 1.0.1 — 2026-07-01

- Renamed the project to **HELM** and removed the wake word: voice is
  push-to-talk only (hold Space). Hands-free wake is now opt-in via
  `WAKE_MODEL` + `WAKE_WORD=on`, with no model bundled.

## Earlier

- Fix: the runner now spawns `claude -p` with `--dangerously-skip-permissions`.
  Headless runs are non-interactive, so the default permission mode silently
  denied the deliverable write — skills ran but produced no report.
- Background skills default to opus (`AGENTIC_OS_MODEL=claude-opus-4-8`) for
  the best report/research quality; switch to sonnet/haiku any time via env.
- HUD (Next.js, three.js orb, file-backed panels).
- Local voice loop: faster-whisper STT + Kokoro TTS, push-to-talk.
- Three-tier intent router: rules → Claude Haiku (optional) → local Ollama
  model (optional) → rules floor.
- Runner daemon executing skills via headless `claude -p`: morning-report,
  inbox-brief, plan-today, plan-tomorrow, vault-cleanup, voice-ask.
- USCF rating feed for the Vitals panel.
