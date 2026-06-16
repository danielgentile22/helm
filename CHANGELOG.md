# Changelog

## Unreleased

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
