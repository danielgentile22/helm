# Arena verdict: Helm 2 visual direction

Judged from source (all three read end to end) plus headless Chrome renders at 390 px and 1300 px,
light and dark, full page.

All three landed on amber. That is convergent evidence the hue is right, and it makes the
comparison about structure and execution rather than palette taste.

## Scores

| Criterion | opus (Amber Rail) | fable (Amber Gutter) | sonnet (Amber Ledger) |
|---|---|---|---|
| 1. Terminal-left-open identity | 3 | 3 | 2 |
| 2. Glanceable state | 3 | 3 | 1 |
| 3. Composer completeness | 3 | 3 | 2 |
| 4. Palette, both themes, 4.5:1 | 3 | 3 | 0 |
| 5. Token discipline | 3 | 3 | 2 |
| 6. Craft | 3 | 3 | 1 |
| **Total** | **18** | **18** | **8** |

### opus — Amber Rail (18/18)

1. **3.** A single hairline rail at 15 px with every block type indented to the same 34 px gutter:
   prompt, thinking, prose, activity and diff hang off one spine with no card backgrounds, so the
   turn reads as one column rather than a stack.
2. **3.** Every row carries a mono state word beside a silhouette-distinct icon (diamond, check,
   slashed circle, triangle, box, ring), the running row adds a travelling amber light on its left
   edge, and "doing now" renders as `Bash npm test -- fold` in mono.
3. **3.** All five states present as separate frames, the send button swaps to a filled ink stop with
   a matching Stop chip in quick actions, the slash popover shows name, description and argument
   hint with the typed prefix underlined, and the skills sheet has scrim, grab handle, search,
   Reload and project/user scope headers.
4. **3.** Warm paper against warm near-black with amber plus indigo as a deliberate second axis;
   documented at 15.1:1 and 15.9:1 for body text, 5.6:1 for amber as text on light.
5. **3.** Four tables (palette, type scale, spacing/radii/geometry, motion) that name the role of each
   token, including `--rail-x` and `--gutter`, and the frames read back those exact values.
6. **3.** No body horizontal scroll, motion on the pulse, rail light, caret, current-tool slide-in and
   gauge fill, a blanket `prefers-reduced-motion` collapse that holds the pulse and caret at full
   opacity, zero external references, and a 1100 px laptop frame in both themes.

Brief violations: none found. Nits: thread-list rows are bordered cards rather than ruled entries,
which is slightly less "ledger" than the log itself; frame 2 is a 1356 px tall screen so one whole
turn fits, which the caption discloses.

### fable — Amber Gutter (18/18)

1. **3.** A 28 px gutter column carries a glyph per line kind (`❯` typed, `∴` thinking, `·` prose,
   `$` tool, `±` diff) with San Francisco for prose and SF Mono for everything the machine said, which
   is the most literal terminal margin of the three.
2. **3.** The list reuses the same gutter for state icons, each paired with a lowercase mono word, and
   the group header carries a pulse plus the words "1 running".
3. **3.** All five states, the send button morphs square-to-round with a spring easing and never moves,
   and a helper row under the composer names the current state and the keyboard bindings.
4. **3.** One hue split into `amber` for fills and `amber-ink` for text (darkened to 5.4:1 on light),
   with body text at 14.6:1 and 14.9:1 and no green anywhere in the app.
5. **3.** A single table covering color, type, space, gutter, radii and motion including both easing
   curves; less granular than opus but nothing is missing and the frames use the values.
6. **3.** No body horizontal scroll, global reduced-motion zeroing that also hides the pulse ring and
   pins the caret visible, no external references, and a 1100 px two-pane laptop frame in a scroll
   container.

Brief violations: none. Nit: the gallery page chrome itself is hardcoded dark and does not follow the
theme toggle, which is page furniture rather than the direction.

### sonnet — Amber Ledger (8/18)

1. **2.** Ledger rows and an origin-tagged prompt line are the right instinct, but the log is a stack
   of separate bordered blocks in a 16 px gap flex column with no spine, so it reads closer to a
   document than to one continuous session.
2. **1.** Icon plus word is there, but `done` is green (#3d6b4a) and `error` is red (#a13a2e), the exact
   pairing the reviewer cannot separate, and in dark mode the row titles do not render at all.
3. **2.** All five states appear, but the skills sheet has no composer row beneath it, the slash popover
   frame is the thinnest of the three, and the send-to-stop change is a fill swap to red with no motion.
4. **0.** The dark gallery is broken: `color` is set only on `html, body` from the light `:root`, so every
   frame inside `#gallery-dark` inherits the light ink (#241f14) on a dark ground. Row titles, headings,
   prose, prompt text and settings labels are effectively invisible in the dark screenshots.
5. **2.** One table, and it omits several tokens that are actually defined and used (`--ink-faint`,
   `--code-bg`, `--accent-soft`, the diff pair); type, space, radius and motion are single summary rows.
6. **1.** Laptop frame present and no body horizontal scroll, but reduced-motion misses the reconnecting
   dot, and half the deliverable (every dark frame) does not render legibly.

Brief violations: dark-theme body contrast fails across nearly every frame; the diff encodes added and
removed as green versus red backgrounds; state color uses the red/green pair for error/done.
No external requests; all required screens are present.

## Recommendation

**Base: opus (Amber Rail).**

It ties fable on every criterion and wins on depth. It ships more of the product (a dedicated
connection-states frame with reconnecting, replaying, offline, turn-failed, orphaned and
input-dropped lines; end-of-turn lines; a laptop pane with a 74ch measure and a `⌘ return` hint),
its token documentation is the one a build could be driven from directly, and its two-axis
amber-plus-indigo palette gives `done` and diff-removed a real second hue without ever reaching for
red versus green. The rail also has room built into it: a fixed 34 px gutter that currently holds
neutral dots is exactly where fable's glyphs drop in.

### Graft from fable

1. **The gutter glyph column.** Replace the rail's neutral dot markers with fable's per-kind glyphs
   (`❯` typed, `∴` thinking, `·` prose, `$` tool, `±` diff) at the existing 15 px rail position. Block
   identity then survives with no color at all, and the thread list reuses the same column for state
   icons so list and log share one skeleton.
2. **The send-to-stop morph plus the composer helper line.** Square-to-round on a spring with the button
   never moving, and a mono helper row that names the composer state in words and shows the key
   bindings. Also worth taking: the strikethrough on removed diff lines, a third non-color cue on top
   of opus's glyph gutter and inset bar.

### Graft from sonnet

1. **Ledger rows for the thread list.** Hairline dividers and right-aligned relative time instead of a
   bordered card per thread; worth trying against opus's cards, since the log is already ruled rather
   than boxed and the list should match it.
2. **The literal `phone ›` / `laptop ›` origin prefix**, used verbatim in both the phone and the laptop
   frame. It is more terminal than opus's `TYPED · MACBOOK PRO` label row and it keeps one grammar for
   "who typed this" across form factors.
