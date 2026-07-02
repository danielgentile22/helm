# Prototype — Core Gallery

**Question:** Which centerpiece graphic should the HELM HUD use? (#4 of the
improvement set.)

**What this is:** a throwaway route (`/proto-cores`) showing every graphic
already implemented in the repo, switchable from a floating bottom bar:

- **PRODUCTION** — `GraphCore` / `DitherCore` / `EmberCore` side by side, all
  live at once. Keys **1–5** push all three through their states
  (idle / working / listening / speaking / error). GraphCore is what's on the
  HUD today; Dither + Ember are currently orphaned (not mounted anywhere).
- **CORE LAB** — the 10 three.js candidates (reuses `/lab`): Helios,
  Singularity, Lattice, Annulus, Uplink, Filament, Embers, Monolith,
  Prominence, Orbital. Click a tile to isolate, esc to return.
- **ORB LAB** — the 10 dither-sphere behaviors (reuses `/orb`): Breath,
  Turbulent, Pulse, Waveform, Scan, Binary, Erode, Contour, Corona, Gaze.

**Run:** `npm run dev`, then open http://localhost:3000/proto-cores
(production `next start` on :3107 won't have this route until rebuilt — use dev).
`←` / `→` switch boards.

**Verdict:** **GraphCore wins** (Daniel, 2026-06-16). It stays the HUD
centerpiece — no swap needed, it's already wired in `components/HUD.tsx`
(import ~line 11, render ~line 1105).

> **Post-v2 note (2026-07):** `components/HUD.tsx` was deleted in the
> tabbed-shell merge (PR #35). GraphCore is now mounted via
> `components/shell/Shell.tsx` → `components/panels/Orb.tsx`.

Per Daniel: **do NOT delete the other cores/labs.** Keep `DitherCore`,
`EmberCore`, `CoreLab` (`/lab`), `OrbLab` (`/orb`), and
`components/ui/dithering-shader.tsx` — he may want them later. So #4 in the
improvement set resolves to **"no cleanup — keep all visuals."**

**Cleanup status:** Nothing to fold in (winner is already live) and nothing to
delete (alternatives kept by request). This prototype route is left in place as
the quick re-compare tool — its switcher bar is dev-only, so a prod build won't
show it. Revisit any time with `npm run dev` → `/proto-cores`. Delete
`app/proto-cores/` + `components/CoreGalleryPrototype.tsx` whenever the gallery
is no longer wanted.
