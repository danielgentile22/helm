# Threlte renders the hero, but the slot does not require it

Scene-graph instruments are built with Threlte 8 on three.js, with the `postprocessing`
library for effects. The hero slot itself stays a plain Svelte component boundary that
knows nothing about either, so an instrument may ignore both and mount its own canvas.

Threlte 8 is the Svelte 5 line: its peer dependency is `"svelte": ">=5"` and its own
source is written in runes, so reactivity is native rather than a compatibility shim. The
usual objection, that a declarative wrapper fights an imperative render loop, does not
apply here: `<Canvas autoRender={false}>` plus `useTask` at the render stage is the
documented way to own the frame. On-demand rendering and scoped disposal are what five
instruments swapping at runtime actually need, and writing those by hand against raw
three.js is the work Threlte has already done.

Effects come from the `postprocessing` library rather than three.js `EffectComposer`.
Three.js's modern pipeline is WebGPU-only, so on WebGL the real choice is between
`EffectComposer` and this, and `postprocessing` merges effects into a single fullscreen
pass and ships `SelectiveBloomEffect` with a `Selection` set. Three.js's own selective
bloom example is a two-composer layer-and-black-material swap. Threlte's documented
example uses `postprocessing`, so this is also the paved path.

The findings behind all of this, with sources, are in
`docs/research/2026-09-16-hero-rendering-stack.md`.

## Consequences

- **The instrument contract names no three.js or Threlte type.** That is what keeps
  ADR 0017's promise honest. A raw WebGL or WebGPU instrument mounts its own `<canvas>`
  and imports neither library, which is a stronger guarantee than any interop API, and it
  holds only as long as the contract stays free of those types.
- **There is no shared post-processing service across instruments.** Post-processing does
  not cross the WebGL to WebGPU line, so a common effects layer would quietly become the
  thing that forecloses a WebGPU instrument. Each instrument owns its own composer.
- **Glow is a real status channel, and it carries exactly one dimension.** Bloom intensity
  is luminance, so it survives red-green colorblindness where hue does not. That makes it
  load-bearing rather than decorative, and it also means a second signal needs a second
  channel: size, motion, or position, never a red-versus-green pairing layered on top and
  called redundant.
- **Post-processing needs a `HalfFloatType` framebuffer and a tone mapping pass.** This is
  a dark full-screen scene running all day. Low-precision buffers band visibly in exactly
  those conditions, so this is setup, not tuning.
- Tide is a GPGPU height field on a 128x128 or 256x256 simulation texture, not a
  Navier-Stokes solver. It costs one or two small passes per frame and it has memory, so
  the four pressure inputs land as impulses that ripple and decay. The reduced-motion still
  is a stateless noise displacement of the same surface.
- River and Kiln may budget hundreds of thousands of particles, conditional on the
  per-particle update living in a shader or a GPGPU texture. A buffer rewritten from
  JavaScript each frame is roughly two orders of magnitude worse and caps out in the low
  tens of thousands. Profile before committing either instrument to a number; the figures
  are three.js's own example sizes, not a measurement on this laptop.
- Installability needs only a manifest and a secure context, where loopback counts. No
  service worker, and no fetch handler, since Chrome 112 on desktop. Offline support is a
  separate decision to make on its own merits.
