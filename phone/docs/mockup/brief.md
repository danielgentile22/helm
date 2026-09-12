# Helm 2 visual direction: candidate brief

Helm 2 drives Claude Code on an always-on Mac from an iPhone (and a laptop). The redesign identity is
"a terminal left open, not a form being submitted": a single-column continuous log per thread with a
terminal frame (prompt lines marked with an origin label, tool activity in monospace) and a readable
rendered-markdown body for assistant text. No chat bubbles. Cost is never shown.

Read first: the repo's `docs/DESIGN.md` (system shape) and the spec text at `spec.md` next to this file
(GitHub issue #18, user stories 1 to 69). Current client CSS is `public/app.css` for what exists today; do
not copy it, the point is a new direction.

## Deliverable

ONE self-contained HTML file at the output path you were given. No external requests of any kind: no CDN,
no web fonts, no images except inline SVG or data URIs. Inline CSS and a small amount of inline JS.
Must open cleanly from `file://` on an iPhone (Safari) and a laptop.

Typography: prose in San Francisco via the `-apple-system, system-ui` stack, code in SF Mono via
`ui-monospace, "SF Mono", Menlo, monospace`.

The file shows your direction as a gallery of phone frames (about 390 px wide each, laid out in a wrapping
row on wide screens and stacked on narrow), one frame per screen and state:

1. Thread list, grouped by project directory, one group with a running thread at the top and a live
   indicator on the group header, a running row showing "doing now", rows with title, state icon plus word,
   relative time. A New button with a secondary chevron.
2. Thread screen with a running turn: header (back, title, context gauge, overflow), a prompt line marked
   as typed input with origin label, a collapsed thinking block, rendered markdown assistant text with a
   heading, list, inline code, a fenced code block with a copy button, a coalesced activity block
   ("read 6 files, ran 2 commands, edited 3 files") with a live current-tool row at the bottom, a diff
   view for one Edit, streaming text with a soft caret, and a "jump to latest" pill. Also show the thin
   reconnecting status bar under the header in this frame or a separate small one.
3. Settings: theme (system, light, dark), push state, passkeys by device, defaults (model, effort, working
   directory), version and host.
4. Composer states, each its own frame or a stacked strip: idle; running (send morphed into stop, stop
   chip in quick actions); slash popover open with three filtered commands (name, description, argument
   hint); skills sheet open with search and a reload action; staged attachments (two image thumbnails
   with remove, one file chip, and a command chip `/grill-with-docs` with argument placeholder).

Every screen in BOTH light and dark. Do it with a `data-theme` attribute on a wrapper so each frame
appears twice, or a toggle at the top of the page that flips the whole gallery; a toggle plus a
"show both" option is best.

Also include at the top of your file a compact token table: your palette (every named color, light and
dark), type scale, spacing scale, radii, motion durations and easings. Render it as an actual table on
the page so the reviewer sees the values next to the frames.

Also, for the laptop: one wide frame (about 1100 px) showing the two-pane layout above 900 px with the
list left and the thread right.

## Hard constraints

- Distinctive palette. Not default iOS blue, not generic chat-app gray. Own a hue.
- Never encode state as red versus green. Every state (running, idle, done, error, orphaned, reconnecting,
  offline, archived) pairs an icon with a word. The reviewer is red-green colorblind.
- Motion is first-class but must respect `prefers-reduced-motion`. Show at least: the running pulse, the
  streaming caret, a current-tool row slide-in. Keep them CSS-only.
- The page body never scrolls horizontally; only the diff, tables, and code blocks may inside their own
  scroll containers.
- Contrast: body text on background at least 4.5:1 in both themes.

## Rationale

Write a second file, `rationale.md`, next to your HTML: 15 to 30 lines. Name the one idea your direction
is built on, the alternatives you considered and rejected, and the two or three things you think are
your strongest moves that would be worth grafting even if another direction wins. No em dashes.
