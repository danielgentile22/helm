# Amber Gutter

## The one idea

The log is a single ruled column with a 28 px gutter on the left, and the gutter carries a glyph for every kind of line: `❯` for what you typed (with a small origin label), `∴` for thinking, `·` for assistant prose, `$` for tool activity, `±` for a diff. That is exactly how a terminal margin works, so the transcript reads as a session left open, not as a conversation between two parties. The same gutter column carries the state icon in the thread list, so list and log share one skeleton. There is one hue, amber, used as phosphor on warm black in the dark and as iron-gall ink on paper in the light. Prose is San Francisco, everything the machine said or you typed is SF Mono.

## Alternatives considered and rejected

Chat-style rails with a colored left border per speaker. Rejected because a colored border is still a bubble in disguise and it makes prose from Claude look like a quote.

A two-hue system (amber for running, a cool blue for idle and done). Rejected because two hues invite state-by-color, which the colorblind rule forbids. Blue survives only inside the diff view, paired with a plus marker, and as the string color in code.

A true green-phosphor terminal skin. Rejected because green reads as "ok" and the app must never lean on that. Amber has no success or failure meaning attached to it.

Cards for every block. Rejected because cards add borders and padding on a 390 px screen where the log needs every pixel of width. Only activity blocks, code, and diffs get a border, because those are the things you scroll inside.

## Strongest moves worth grafting

1. The gutter glyph column. It gives every line kind an identity without any color, it aligns prose, prompts, and tool rows on one left edge, and the thread list reuses it for state icons so a running thread pulses in the same place a running tool row does.
2. The colorblind-safe diff: added lines in blue with a plus, removed lines in amber with a minus and a strikethrough. Three cues per line, none of them red or green, and it survives grayscale.
3. Amber as a single accent split into two tokens: `amber` for fills (send button, pulse ring, caret, gauge) and `amber-ink` for text, which is darkened in the light theme to 5.4:1. That split is what lets one hue pass contrast in both themes without a second color.

Also worth keeping regardless of base: the send button morphs to a round stop with a spring easing and never moves, and the reconnecting bar is amber-soft with a monospace replay count, so it looks like a terminal line and not an alert.
