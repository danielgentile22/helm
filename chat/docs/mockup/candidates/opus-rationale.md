# Amber Rail

**The one idea: the thread is a single line, and everything hangs off it.** A terminal is not a stack of containers, it is one continuous column with a left margin, and the margin is where you find your place. So the whole structure budget goes to one element: a hairline rail at a fixed 15px running the full height of the log, with every block type indented to the same 34px gutter. Prompts, thinking, prose, activity and diffs are not cards on a background, they are entries against a spine. That is what makes it read as a session left open instead of a feed of messages.

The rail then does the second job for free. A turn owns its stretch of the spine, and while it runs that stretch carries a travelling amber light. No separate spinner to place, no badge to hunt for: the living part of the screen is the line you were already reading down. The same gradient runs on the left edge of a running row in the thread list, so one motif means "alive" in both places.

**The palette owns amber against warm ink, with indigo as the second axis.** Nothing is neutral gray or iOS blue. Light is warm paper, dark is warm near-black, amber is burnt on light (5.5:1 as text) and bright on dark. The second colour is indigo on purpose: amber and blue are the pair that survives red-green colour blindness intact. That is load-bearing, not decorative. The diff renders added lines in amber and removed lines in indigo, each with a `+` or `−` glyph in its own gutter column and a word tally ("2 added, 1 removed") in the header. A diff is the one place red versus green is the industry default, and this direction needs no exception carved out for it.

**Rejected.** A true phosphor terminal, monospace everywhere: story 20 wants readable markdown on a phone, and all-mono prose is the fastest way to make a long answer unreadable. Bubbles with an accent tint: ruled out by the brief. Elevation on every block: that is exactly what makes the current client read as a form, and it fights the continuous-log identity. Colour-coded tool categories: three more meanings loaded onto colour for a reviewer who cannot lean on it, when the coalesced summary already says the counts in words.

**Worth grafting even if another direction wins.**

1. **The rail as structure and live indicator at once.** One pseudo-element carries the terminal identity, the block hierarchy, and the running state, and it replaces a spinner, a badge, and a set of block backgrounds.
2. **The amber-and-indigo diff with glyph gutters and a word tally.** It solves the colour-blind constraint at the one place that is genuinely hard, and it ports into any palette with two distinguishable hues.
3. **State as a mono word plus a shape, always together, always the same size.** `running`, `done`, `orphaned`, `error`, `archived`, `idle` sit in 11px tracked mono beside a shape that differs by silhouette and not only fill: diamond, check, slashed circle, triangle, box, ring. Read the shape or read the word, either is sufficient.

Motion is small and CSS-only: a pulse that expands a ring instead of blinking, a current-tool row sliding in from the rail, a gauge that fills once on mount, a caret that fades to 22 percent rather than hard-blinking. All of it collapses under `prefers-reduced-motion`, with the pulse and caret held at full opacity so state stays readable when motion is off.

Verified in headless Chrome: no horizontal page scroll at 320, 375, 390, 430, 768 and 1280px; no frame clipped and nothing overflowing outside the allowed scroll containers; body text at 15.9:1 light and 16.3:1 dark; zero network requests; identical render from `file://`.
