# Visual direction: Amber Rail

Chosen by Daniel on 2026-09-12 from the three-candidate arena in `docs/mockup/` (issue #21).
Tokens live in `src/client/tokens.css`. The redesign pull request wires them in; nothing imports
them yet.

## The idea

The thread is one line and everything hangs off it. A hairline rail at `--rail-x` runs the full
height of the log, every block indents to `--gutter`, and no block has its own background. While a
turn runs, the stretch of rail the turn owns carries a travelling amber light (`--d-rail`), so the
living part of the screen is the line you are already reading. The same gradient sits on the left
edge of a running row in the thread list.

Two signal hues, amber and indigo, because that pair survives red-green colorblindness. Amber is
`--accent` as text, `--accent-solid` as fills. Indigo is `--cool`: done state, links, keywords,
removed diff lines. `--alert` is for errors only and always sits next to a triangle and the word.
The diff renders added lines in amber and removed in indigo, each with a `+` or `-` glyph gutter
and a word tally in the header.

State is always a shape plus a mono word at the same size: diamond running, check done, slashed
circle orphaned, triangle error, box archived, ring idle.

## Grafted from the other candidates

From Fable (Amber Gutter):

- The gutter glyph column. The rail's neutral markers become a glyph per line kind: `❯` typed,
  `∴` thinking, `·` prose, `$` tool, `±` diff. Block identity then survives with no color at all,
  and the thread list reuses the same column for its state icons.
- Strikethrough on removed diff lines, a third non-color cue on top of the glyph gutter and the
  indigo tint.
- The send-to-stop morph on `--e-spring`, square to round, with the button never moving. Fable's
  spring easing is the one non-Opus token in the file.
- The mono helper line under the composer that names the state in words (idle, running, replaying)
  and shows the key bindings.

From Sonnet (Amber Ledger):

- Ledger rows for the thread list. Hairline dividers and right-aligned relative time instead of a
  bordered card per thread, so the list is ruled the way the log is.
- The literal `phone ›` / `laptop ›` origin prefix on prompt lines, used verbatim on both form
  factors, in place of the `TYPED · MACBOOK PRO` label row.

## Rejected

- Fable's single-hue system. One hue passes contrast in both themes, but it leaves the diff and the
  done state with nowhere to go except amber again. Indigo as a second axis is what makes the diff
  need no exception.
- Sonnet's palette. Its `--done` is green and `--error` is red, which the colorblind rule forbids,
  and its dark theme set `color` only from the light root, so most text vanished.
- Sonnet's ring gauge. Opus's gauge already animates on mount and the ring reads no better at 28 px.
- Elevation on every block, from all three at some point in their rationale. That is what makes the
  current client read as a form.

## Motion rules

Nothing animates on a text delta. The caret fades to 22 percent on `--d-caret`, never a hard blink.
The running pulse expands a ring, it does not blink. Under `prefers-reduced-motion` every duration
collapses to 1 ms and pulse and caret hold at full opacity so state stays readable.
