# PRD — HELM Improvement Set (June 2026)

> One PRD covering the full set of accepted improvements. It is intentionally
> broad — split it into separate work items along the numbered sections below.
> Each section is self-contained and labeled with its original idea number.
>
> **Status of the visual decision (#4):** resolved before this PRD was written.
> GraphCore is the chosen centerpiece and is already live; all alternative cores
> and lab routes are **kept, not deleted** (Daniel may revisit). #4 therefore
> carries no work and appears only under _Out of Scope_.

---

## Problem Statement

HELM started as a downloaded "Jarvis" template and has since been rebranded into
Daniel's own personal HUD. Several things follow from that history and from how
the cockpit is actually used day to day:

- **Template residue still ships.** The vitals system carries dormant
  influencer-dashboard plumbing (YouTube / Instagram / TikTok mock metrics, a
  "Latest Video" tile) that Daniel never uses. A bundled demo vault, a stale
  Python virtualenv path, a placeholder local-router model tag, and a now-inert
  wake-word listener are all left over from the template or the rebrand.
- **The HUD doesn't yet serve Daniel's top directives.** His standing priorities
  are, in order: land a SWE job, land Morphy Consulting's first client, reach
  1600 USCF. The cockpit surfaces his chess rating and the Morphy board, but has
  nothing tracking the job search, no view of Morphy's engineering activity, and
  no running tally of his own Claude Code usage.
- **Some surfaces are scaffolded but not wired to reality.** The centerpiece
  already reacts to system state and the audio panel already animates, but the
  reactions are partly canned rather than driven by live signals. The rating
  tile has no progress-to-goal. The command deck shows queued work but not what's
  actively running. Documents open only inside an in-app overlay, never in the
  real Obsidian vault.
- **There's no weekly synthesis** across the three directives, and **nothing
  notifies Daniel** when long-running work lands or the shared Morphy board
  changes while he's away from the tab.

## Solution

A single coordinated pass that (a) deletes the template residue, (b) adds the
data and skills that serve Daniel's directives, and (c) finishes wiring the
already-scaffolded visuals to live signals. Concretely:

- **Cleanup:** purge the social-metrics code path and demo data, fix the router
  model tag, trim the wake-word module to a clean opt-in scaffold, recreate the
  voice virtualenv so its paths are correct, and make the vault root an explicit
  required setting instead of falling back to a bundled demo vault.
- **New data:** a job-application tracker tile, a GitHub-activity feed scoped to
  the Morphy repository only, a Claude Code token-usage feed (the tile already
  exists — only the feed is missing), and a reliably-populated "today's agenda"
  strip fed from Calendar.
- **New features:** native macOS notifications when reports land or the Morphy
  board shifts, and a weekly-review skill that synthesizes the week across all
  three directives.
- **Visual polish:** extend the state-reactive centerpiece with event "flares,"
  drive the audio meter from real amplitude, add an animated progress-to-1600
  bar on the rating tile, put sparklines on the new tiles, show the actively-
  running skill on the command deck, and add an "open in Obsidian" deep-link
  affordance on documents.

The work is decomposed into small **deep modules** (pure helpers, feed scripts,
a notification decider, a skill contract) so the riskiest logic is testable in
isolation, with the React/visual surfaces kept thin around them.

---

## User Stories

### Cleanup & hygiene

1. As Daniel, I want the dormant YouTube / Instagram / TikTok metrics and the
   "Latest Video" tile removed, so that my vitals panel only shows numbers I
   actually care about and nothing reads like an influencer dashboard.
2. As a maintainer, I want the metric-tile config renamed from its
   social-media-era name to a vitals-neutral name, so that the code reflects
   what it now does.
3. As Daniel, I want the local-router model tag to default to the model that's
   actually installed, so that voice routing works on a fresh run even if I
   forget to set the override env var.
4. As a maintainer, I want the inert wake-word listener trimmed to a clean,
   clearly-opt-in scaffold (kept, not deleted) with any genuinely-dead wiring
   removed, so that the module is honest about being push-to-talk-by-default and
   is ready for me to enable hands-free later.
5. As Daniel, I want the voice virtualenv's internal paths to match the project's
   current location, so that pip/activate and any tooling inside the venv aren't
   pointing at the old template folder.
6. As Daniel, I want the bundled demo vault deleted and the vault root made a
   required setting with a clear error when it's unset, so that the app always
   runs against my real vault and never silently renders demo data.
7. As a maintainer, I want the ignore rules and any fallback references to the
   bundled demo vault cleaned up when it's removed, so that nothing dangles.

### Job-application tracker (#7)

8. As Daniel, I want a vitals tile showing how many jobs I've applied to, so that
   my top directive (land a SWE job) is visible on the cockpit every day.
9. As Daniel, I want the job tile to show a short-term delta (e.g. applications
   this week) and a sparkline of history, so that I can see momentum, not just a
   total.
10. As Daniel, I want application records stored as plain files in the vault, so
    that the underlying data is mine, greppable, and survives independent of the
    HUD.
11. As Daniel, I want the capture mechanism (voice command vs. manual edit vs.
    inbox-detection) left open for now, so that we can choose how logging works
    after the data shape is in place.

### GitHub activity — Morphy only (#8)

12. As Daniel, I want a feed that reports recent engineering activity on the
    Morphy repository only (no other repos), so that Morphy's build progress is
    reflected on the cockpit without leaking my other GitHub work.
13. As Daniel, I want the Morphy repo identified by a single configurable
    setting, so that I can point the feed at the right repository (or unset it
    and have the feed no-op cleanly).
14. As Daniel, I want Morphy's recent commits / open PRs surfaced either as a
    vitals tile or folded into the existing Morphy panel, so that it sits
    alongside the board status.

### Claude Code token feed (#9)

15. As Daniel, I want a feed that records my Claude Code usage for the rolling
    5-hour window, so that the existing "Claude 5h Window" tile finally shows
    real data instead of nothing.
16. As Daniel, I want that feed scheduled to run on a cadence, so that the tile
    stays current without me running anything by hand.

### Today's agenda strip (#11)

17. As Daniel, I want the schedule panel to reliably show today's agenda from my
    calendar, so that I can see what's next without opening Google Calendar.
18. As Daniel, I want the agenda kept fresh by the runner (which has calendar
    access) and read from a cache by the HUD, so that the web layer never calls
    Calendar directly and the same local-only firewall as the Morphy board
    holds.
19. As Daniel, I want the current/just-started block highlighted, so that I can
    tell at a glance where I am in the day. _(Already present; preserve.)_

### System notifications (#15)

20. As Daniel, I want a native macOS notification when a long-running report
    lands (morning report, inbox brief, etc.), so that I learn it's ready even
    when the HUD tab isn't focused.
21. As Daniel, I want a notification when the Morphy board changes (cards added
    or closed) on a sync, so that I notice Michael's edits without watching the
    board.
22. As Daniel, I want to enable/disable notifications and filter which events
    fire one, so that I can keep only the alerts I find useful.
23. As Daniel, I want notifications fired by the runner (not only the browser),
    so that they work even when no HUD tab is open.

### Weekly review skill (#16)

24. As Daniel, I want a weekly-review skill that synthesizes the past week across
    all three directives (job search, Morphy, chess), so that I get a single
    Sunday note instead of reconstructing the week from scattered files.
25. As Daniel, I want the weekly review to draw on my daily notes, delivered
    reports, the Morphy board, and metric history, so that it's grounded in what
    actually happened.
26. As Daniel, I want a command-deck button and an automatic weekly schedule for
    it, so that I can run it on demand or let it run itself.
27. As Daniel, I want the weekly review to land as a vault document in the same
    trail as my other reports, so that it's openable from the cockpit like
    everything else.

### Reactive centerpiece (#18)

28. As Daniel, I want the core to keep reacting to system state (idle / working /
    listening / speaking / error) as it already does, so that the centerpiece
    reflects what HELM is doing. _(Already wired; preserve.)_
29. As Daniel, I want the core to "flare" briefly on discrete events — a report
    landing, a run completing, a Morphy delta — so that meaningful moments read
    as a visible pulse, not just a steady mode.
30. As Daniel, I want the mode-to-feel mapping tuned so each state is visually
    distinct, so that I can tell working from speaking from error without
    reading the label.

### Live audio meter (#19)

31. As Daniel, I want the audio panel's bars driven by real amplitude — HELM's
    TTS level while speaking, my mic level while I'm holding to talk — so that
    the meter reflects actual sound instead of a canned animation.
32. As Daniel, I want the meter to fall back gracefully to a neutral idle state
    when there's no live audio, so that it never looks broken.

### Rating progress bar (#20)

33. As Daniel, I want an animated progress bar on the USCF rating tile showing
    how close I am to 1600, so that my chess directive has a visible target.
34. As Daniel, I want the bar measured within a sensible band (a floor up to the
    goal) rather than from zero, so that the bar is informative rather than
    always near-full.

### Sparklines (#21)

35. As Daniel, I want sparklines on the new tiles (job applications, Morphy
    GitHub, Claude tokens) like the ones already on my vitals, so that every
    tracked number shows its trend, not just its current value.

### Active-skill indicator (#22)

36. As Daniel, I want the command deck to show which skill is actively running
    with a spinner and elapsed time, distinct from "queued," so that I can tell
    in-progress work from waiting work at a glance.
37. As Daniel, I want the deck's running indicator to stay consistent with the
    live task cards around the core, so that the two surfaces don't disagree.

### Open in Obsidian (#23)

38. As Daniel, I want documents (in the trail and on the core callouts) to offer
    an "open in Obsidian" action that opens the real note in my vault, so that I
    can edit it directly instead of only viewing it in the in-app overlay.
39. As Daniel, I want the in-app overlay to remain the default click, with the
    Obsidian deep-link as a secondary affordance, so that the quick-glance flow
    is unchanged.

### Cross-cutting

40. As a maintainer, I want every new metric to flow through the same vault CSV
    contract the existing feeds use, so that tiles, sparklines, and history all
    work without special-casing.
41. As a maintainer, I want the riskiest new logic (URI building, progress math,
    amplitude mapping, mode derivation, the skill contract, the feed compute
    steps) extracted into pure, testable units, so that the visual layers stay
    thin and the logic is verifiable.
42. As Daniel, I want all new scheduled jobs to use the project's existing
    launchd naming and logging conventions, so that they show up and behave like
    the feeds and runner I already have.

---

## Implementation Decisions

### Module map (build / modify)

The work is organized around these modules. Several are **deep modules** — a lot
of behavior behind a small, testable interface.

**Pure helpers (new, tested):**

- `ratingProgress(value, goal, floor)` → percent in `[0,100]`. Bar measures the
  value within a `[floor, goal]` band, clamped. Floor is configurable with a
  sensible default (≈1200) so the bar isn't pinned near full. (#20, #34)
- `obsidianUri(vaultName, relPath)` → an `obsidian://open?vault=…&file=…` string,
  with the vault name and the vault-relative path (extension dropped) URL-encoded.
  Vault name comes from the existing public Obsidian-vault setting. (#23)
- `levelToBars(level, n)` → array of `n` bar heights from a `0..1` amplitude,
  shaped like a VU meter (center-weighted), monotonic in `level`. (#19)
- `deriveCore(signals)` → `{ mode, flare? }`. Extracts and extends the core-mode
  derivation that currently lives inline in the HUD. Same precedence as today
  (`error > listening > speaking > working > idle`) plus a transient `flare`
  emitted on discrete events (terminal run, report landing, Morphy delta). (#18)

**Centerpiece (modify):** the chosen GraphCore gains a brief, decaying "flare"
reaction (a brightness/spread pulse) triggered by `deriveCore`'s `flare`, layered
on top of its existing mode feels. Mode→feel constants are re-tuned for
legibility. No new component; GraphCore stays the only mounted core. (#18, #29,
#30)

**Audio meter (modify):** the audio panel's existing bar array is driven by
`levelToBars` fed from a real amplitude source — the TTS playback level (already
exposed by the voice client) while speaking, and a mic-input level while the
push-to-talk capture is active. Falls back to a flat idle state with no live
audio. (#19, #31, #32)

**Vitals tile config (modify):** the metric-tile definition list (currently
named for social media) is renamed to a vitals-neutral name and extended from
`{source, metric, label, raw?}` to also carry an optional `goal` (drives the
rating progress bar) and to support the new sources (jobs, github). The existing
sparkline and stale-age logic are reused unchanged. The "Latest Video" tile and
its `latestVideo` state plumbing are removed. (#1, #2, #8, #9, #20, #21, #35)

**Metric-feed toolkit (new + modify):** a shared "append a metrics row" helper
and one feed script per source, mirroring the existing USCF feed. Stable CSV
contract: `timestamp, source, metric, value, status, error`. Appends are
**idempotent** within a source/metric for the relevant window (no duplicate rows
on re-run). New feeds:
- **Claude tokens (#9):** computes the rolling 5-hour output-token total from
  Claude Code's local usage data and appends `claude_code / tokens_5h`.
- **GitHub / Morphy (#8):** reads recent activity (commits in the last 7 days,
  open PRs/issues) for **one** repository identified by a configurable
  `owner/repo` setting; appends under a `github` source. If the setting is
  unset, the feed no-ops and records nothing. **Open dependency:** Daniel must
  supply the Morphy repo slug; if Morphy has no code repository this item is
  blocked on that.
Both feeds are scheduled via launchd using the project's `com.helm.*` naming and
shared log directory. (#15-style cadence; #40, #42)

**Job-application store (new):** application records persist as plain vault files
(JSON-lines or a markdown table under the system area). A pure `jobStats(records)`
derives the displayed metric(s) — total and applications-this-week — which a small
job feed writes into the CSV contract so the tile/sparkline work like any other.
The **capture mechanism is deliberately deferred** (voice intent vs. manual vs.
inbox-detection) — only the data shape and the read/derive path are in scope now.
(#7, #8-#11 stories)

**Agenda cache (new + modify):** the runner (which has Calendar access via the
headless agent) maintains an `agenda` cache file of the next N events on a
cadence, the same pattern as the Morphy-board cache. The state API merges it into
the daily payload; the existing Schedule panel renders it and keeps its
current-block highlight. The HUD never calls Calendar directly — same path-scoped,
local-only firewall as the Morphy/Notion integration. The daily-note schedule
remains the fallback when the cache is absent. (#11, #17-#19)

**Notification dispatcher (new):** a runner-side decision module
`decideNotification(event, config)` → `{ title, body } | null`, plus a thin
emitter that shells out to macOS `osascript`. Events considered: run completed
with a deliverable, run failed, Morphy delta (added/closed > 0). Config gates
enable/disable and which event types fire. Runs in the runner so alerts work with
no HUD tab open. (#15, #20-#23)

**Weekly-review skill (new):** added to the allowed-skills set and the runner's
prompt-builder with its own deliverable path in the reports trail; a command-deck
button; and a weekly schedule. The prompt synthesizes the week across the three
directives from daily notes, delivered reports, the Morphy board cache, and
metric history. It is a headless-agent skill (like the morning report), not a
native in-process skill. (#16, #24-#27)

**Command-deck running state (modify):** the deck derives each skill's live state
by correlating the runner's active runs (status = running) and the queue with the
deck's skill roster, rendering a RUNNING state (spinner + elapsed) distinct from
the existing QUEUED/cooldown state, and consistent with the live task cards
already shown around the core. (#22, #36, #37)

**Documents / callouts (modify):** document rows and core callouts keep their
current click (in-app overlay) and gain a secondary "open in Obsidian" affordance
built from `obsidianUri`. (#23, #38, #39)

**Config hardening (modify):** the vault-root setting becomes required in both the
web config and the runner; the bundled-demo-vault fallback is removed and the
directory deleted; unset vault root throws a clear, actionable startup error.
Ignore rules referencing the demo vault are cleaned up. (#6, #7 story)

**Small cleanups (modify):** local-router default model tag corrected to the
installed tag (#3 story / idea #2); wake-word module trimmed to a clean opt-in
scaffold with dead wiring removed and its startup confirmed to be conditional on
the wake-model setting (idea #3); voice virtualenv recreated so internal paths are
correct (idea #5).

### Contracts & schema

- **Metrics CSV row:** unchanged contract `timestamp, source, metric, value,
  status, error`. New sources: `jobs`, `github`; new metric on existing source:
  `claude_code / tokens_5h`. Tiles, sparklines, deltas, and stale-age all key off
  this — no per-source UI special-casing.
- **Vitals tile def:** `{ source, metric, label, raw?, goal? }`. `goal` present →
  render the progress bar via `ratingProgress`.
- **Agenda cache:** a small JSON file of upcoming events (time + title), written
  by the runner, read by the state API, shaped to match the existing daily
  `schedule` items so the panel renders them unchanged.
- **Notification event:** `{ type, … }` where type ∈ { run-complete, run-failed,
  morphy-delta }; the decider maps event + config → an optional `{title, body}`.
- **Skill contract:** every allowed skill is either native (in-process) or has a
  prompt-builder case **and** a deliverable path. `weekly-review` is non-native
  and must satisfy both.

### Interactions

- The core's `flare` is transient and decays; it never latches mode. `deriveCore`
  owns both mode precedence and flare emission so the HUD just forwards the
  result to GraphCore.
- The audio meter and the core both read amplitude; the meter uses `levelToBars`,
  the core uses the raw level it already consumes — one amplitude source, two
  consumers.
- Notifications are the runner's responsibility, not the browser's, so they're
  independent of whether a HUD tab is open.

---

## Testing Decisions

**What a good test is here:** assert externally-observable behavior, not
implementation. For a pure helper that means given-inputs → exact output; for a
feed that means given fixture input → the correct computed value and a
well-formed, non-duplicated CSV row; for the skill contract that means the
allowed-skills set and the runner agree. No snapshot-of-internals, no testing
React render trees.

**Prior art:** the existing `scripts/test-router.ts` suite (run via `npm test`,
tsx, ~19 router + 7 capture assertions) is the model — a plain script of
explicit assertions. New TypeScript tests follow that shape and hang off the same
runner.

**Modules to be tested (confirmed scope):**

- **Pure helpers** —
  - `ratingProgress(value, goal, floor)`: e.g. `(1545, 1600, 1200) ≈ 86.25`;
    clamps below floor → 0 and at/above goal → 100.
  - `obsidianUri(vault, relPath)`: e.g. `("Vault",
    "inbox/reports/morning/2026-06-16-x.md")` →
    `obsidian://open?vault=Vault&file=inbox%2Freports%2Fmorning%2F2026-06-16-x`;
    spaces and unicode in the vault name are encoded.
  - `levelToBars(level, n)`: `level=0` → all at the floor; `level=1` →
    center-weighted peak; output length always `n`; monotonic as `level` rises.
  - `deriveCore(signals)`: mode precedence (`error > listening > speaking >
    working > idle`); `flare` emitted exactly once per new terminal run / report
    / Morphy delta and absent otherwise.
- **Skill contract** — extend/add a parity check asserting every allowed skill is
  native **or** has both a prompt-builder case and a resolvable deliverable path,
  and that `weekly-review` specifically satisfies it and has a valid schedule
  entry.
- **Feed scripts** — for the Claude-token and GitHub/Morphy feeds: given a fixture
  input (sample usage data / sample API JSON) the compute step yields the expected
  metric value and a well-formed CSV row, and a second run does not duplicate the
  row (idempotency). Where the feed is Python (consistent with the existing USCF
  feed), the compute step is factored so it can be exercised against a fixture and
  driven from the test runner.

**Explicitly not tested (by decision):** the notification dispatcher. It's a thin
`osascript` wrapper around a small decision; revisit if its decision logic grows.
Visual/presentational surfaces (core flare rendering, meter bars, deck spinner,
tile layout) are validated by eye, not unit tests — their logic is what's
extracted into the tested pure helpers above.

---

## Out of Scope

- **#4 — core visual selection / cleanup.** Resolved separately: GraphCore stays
  the centerpiece (already live) and every alternative core and lab route is
  **kept by request**. No work here. The throwaway `/proto-cores` comparison
  gallery is left in place as a re-compare tool (its switcher is dev-only) and is
  not part of this PRD.
- **Hands-free wake word.** The wake-word module is trimmed and kept as an opt-in
  scaffold, but actually enabling hands-free (training/wiring a model) is future
  work, not this PRD.
- **Job-application capture mechanism (#7).** Only the data shape and read path
  are in scope; how applications get logged (voice / manual / inbox-detection) is
  deferred.
- **Two-way sync for any feed.** GitHub, Calendar, and Claude-usage feeds are
  read-only into the vault; no writing back to those services.
- **Browser/web push notifications.** Notifications are macOS-native via the
  runner; in-browser web notifications are not included.
- **Auto-played spoken briefings, resume-tailoring, command palette/hotkeys.**
  Considered and declined for this set.
- **Chess depth beyond rating, an RF/antenna feed, and an inbox unread tile.**
  Declined for this set (the morning report already covers the RF beat).

## Further Notes

- **Already-built foundations** (so implementers don't rebuild them): the
  centerpiece already derives and reacts to mode and consumes real TTS amplitude;
  sparklines already render on vitals tiles; the schedule panel already exists and
  is mounted; the Claude-token tile already exists (only its feed is missing); the
  Morphy objective already has the animated-progress-bar pattern to mirror for the
  rating bar. These items are "finish the wiring," not "build from scratch."
- **Local-only firewall.** Any new connector data (Calendar agenda, GitHub) must
  follow the established pattern: the runner (headless agent / scripts) fetches and
  writes a vault cache; the web layer only reads local files. The HUD never calls
  an external API directly.
- **Directive alignment.** Prioritize when splitting: the job tracker (#7) and the
  Claude-token feed (#9) and the weekly review (#16) most directly serve the top
  directives and the daily workflow; the visual-polish items (#18-#23) are high
  delight-per-effort because the scaffolding already exists; the cleanup items
  (#1-#3, #5, #6) are cheap and reduce confusion.
- **Scheduling/launchd.** New feeds and the weekly review should register as
  `com.helm.*` launchd agents (or runner-internal cadences) with logs in the
  project log directory, matching the existing USCF feed and runner.
