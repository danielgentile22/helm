# Visual direction arena (issue #21)

Open `index.html` and switch between the three candidates. Each candidate page has its own
light, dark, and show-both toggle, a token table at the top, every screen and composer state,
and a laptop two-pane frame. The brief every candidate received is `brief.md`.

## Candidates

| Candidate | Name | One idea |
|---|---|---|
| Opus | Amber Rail | One hairline rail runs the full log; every block hangs off it and the rail carries a travelling light while a turn runs. Amber plus indigo as the two signal hues. |
| Fable | Amber Gutter | A 28 px gutter carries a glyph per line kind (typed, thinking, prose, tool, diff). One hue, amber, phosphor in dark and iron-gall ink in light. |
| Sonnet | Amber Ledger | Thread list as ledger rows, context gauge as a partial ring, one amber accent. |

All three chose amber independently. That convergence is the strongest signal in the arena and
amber is treated as settled.

## Recommendation (awaiting Daniel's pick)

Base: **Opus, Amber Rail.** The cross-judge (`judge.md`, run on a different model from the
orchestrator) scored Opus and Fable 18/18 each and Sonnet 8/18, and recommended Opus on depth:
it is the only candidate with a frame for every connection state and end-of-turn line, its token
tables are build-ready, and indigo as a second axis keeps `done` and removed diff lines off the
red and green pair.

Grafts proposed if Opus is the base:

1. From Fable, the gutter glyph column (`❯` typed, `∴` thinking, `·` prose, `$` tool, `±` diff)
   in place of the rail's neutral markers, and the strikethrough on removed diff lines.
2. From Fable, the square-to-round send-to-stop morph on a spring with the button never moving,
   and the mono helper line under the composer naming the state and key bindings.
3. From Sonnet, ledger rows for the thread list (hairline dividers, right-aligned time) instead
   of cards, and the literal `phone ›` / `laptop ›` origin prefix on prompt lines.

Sonnet is not a viable base: its dark theme inherits light ink so most text vanishes, its diff
and state tokens encode meaning as red versus green. An earlier note here said it overflows at 390 px; that was a screenshot
tool artifact and all three candidates fit at phone width.

Once a base is picked, the chosen values land as design tokens in the repo and this note becomes
the design note recording what was grafted and why.
