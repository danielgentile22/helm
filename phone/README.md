# Helm 2.0

Drive Claude Code on the always-on Mac from an iPhone. A self-hosted web app, installed to the
home screen, served over the tailnet with HTTPS from `tailscale serve`, gated by a passkey.

Each thread is an append-only event log on disk. Everything else (the phone's rendering, the
thread list, the markdown mirror in the vault, push notifications) is a projection of that log.
Lock the phone, lose signal, relaunch the app: the turn keeps running and reconnecting replays
exactly what was missed.

- Design: `docs/DESIGN.md`. Grounding and rejected options: `docs/GROUNDING.md`.
- Host setup and the migration checklist: `docs/SETUP.md`.
- Spec of record: GitHub issue #1.

```
npm ci && npm run build:client
npm test
npm start
```
