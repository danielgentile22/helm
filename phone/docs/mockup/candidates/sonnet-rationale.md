# Amber Ledger

The core idea: one warm hue does all the accenting work a chat app would spread across brand
color, primary buttons, and unread badges, and every non-neutral state gets an icon plus a word
instead of a second hue. Amber reads as "terminal left on" (a CRT phosphor glow, a pilot light)
without literally imitating green phosphor, which felt like costume rather than direction. The
thread list is styled as ledger rows (hairline dividers, right-aligned relative time, no avatars,
no bubbles) because the brief's identity is a log, not a conversation.

Alternatives considered and rejected:

- **True green phosphor.** Too referential and it fights readability at small sizes in daylight
  on an iPhone; amber holds contrast better against a warm paper background.
- **Card-based thread list with shadows.** Contradicts "a form being submitted" being the thing
  we're avoiding. Cards imply discrete submitted objects; ledger rows imply a continuous record.
- **Colored state chips (a pill per state).** Rejected for the colorblind constraint. Once every
  state needs an icon and a word anyway, a colored pill adds nothing but visual noise, so states
  use a single glyph plus the word inline instead of a badge.
- **Bottom tab bar.** The spec's screens (list, thread, settings) don't need persistent chrome
  competing with the log; a plain header and back arrow keeps the frame count honest.

Strongest moves worth grafting regardless of outcome:

1. **The context gauge as a partial ring, not a percentage number or a bar.** It reads at a
   glance and never needs a color threshold (no red-line danger zone), so it survives the
   colorblind constraint for free.
2. **The activity block collapsing static history into a one-line summary with only the current
   tool animated at the bottom.** It keeps the log scannable during a long turn instead of
   scrolling a receipt of every tool call.
3. **Single origin-tagged prompt line style (`phone ›` / `laptop ›`) reused verbatim in the
   two-pane laptop frame.** One visual grammar for "who typed this" that doesn't change shape
   between form factors, which matters given phone and laptop can write to the same thread.
