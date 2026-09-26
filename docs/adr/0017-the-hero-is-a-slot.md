# The hero is a slot, not a thing

The centre of the dashboard is a contract, not a visualisation. It receives system
state, renders, responds to the selected department, and pauses when hidden.
Instruments plug into it and swap at runtime. Since ADR 0023 that centre is a wide
band between two rows of department boxes rather than a tall column between four,
and nothing in this contract changed for it.

The contract has to be general enough that a black screen and an interactive terminal
are both valid instruments. If it is not, otto has to be rebuilt every time Daniel
gets bored of the centrepiece, and he will.

## Consequences

- **An instrument is redundant, never load-bearing.** Whatever it says, the surrounding
  panels say too. That is what keeps a WebGL failure or a lost context from making the
  screen unreadable, and it is also the correct accessibility answer: nothing exists
  only inside a canvas.
- Every colour is a token on `:root`. No instrument hardcodes one, so theme and palette
  stay runtime-switchable and the settings page is later work rather than a refactor.
- Instruments pause when hidden and honour `prefers-reduced-motion` with a still state
  that still looks intentional. This runs full-screen all day.
- Status never depends on hue. Brightness, size, motion, position and shape carry the
  signal instead, which is both the colorblindness answer and the better design.
