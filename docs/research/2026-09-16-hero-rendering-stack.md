# Hero rendering stack for the otto dashboard

Research date: 2026-09-16. Target: `~/Projects/otto/dashboard/`, Svelte 5 with runes, Vite,
Hono on Node, TypeScript strict, installed as a progressive web app on loopback, full-screen
dark, 60fps on Apple Silicon.

Versions checked live against the npm registry and GitHub on 2026-09-16:
`three` 0.186.0 (2026-09-08), `@threlte/core` 8.6.0 and `@threlte/extras` 9.21.1
(both 2026-08-26), `postprocessing` 6.39.5 (2026-09-09), `svelte` 5.57.0 (2026-08-28).

## Recommendation

**Use Threlte 8 for the scene-graph instruments, and keep the hero slot a plain Svelte
component boundary so a non-Threlte instrument can take the slot.** Threlte 8 requires
Svelte 5 (`"svelte": ">=5"` in its peer dependencies) and its own source is written in runes,
so the reactivity is native rather than a shim. It does not fight the render loop: the
`<Canvas>` component takes `autoRender={false}` and `useTask` lets you own the frame,
which is exactly what a hand-written instrument needs.

**Use the `postprocessing` library (pmndrs/vanruesc) rather than three.js `EffectComposer`,
and use its `SelectiveBloomEffect` for per-object glow.** Three.js still ships
`EffectComposer` in `examples/jsm`, and its own selective-bloom example is a two-composer
layer-swap hack. `postprocessing` merges effects into one fullscreen pass and ships
selective bloom as a first-class effect with a `Selection` set you add objects to. Threlte's
own documented postprocessing example uses this library, so this is the paved path.

**Progressive web app install on Chrome desktop needs only a manifest plus a secure
context, and `http://localhost` or `127.0.0.1` counts as secure.** A service worker with a
fetch handler has not been required for installability since Chrome 112 on desktop. Ship a
manifest with `name`, a 192px and a 512px icon, `start_url`, and `display: "standalone"`
(or `"window-controls-overlay"`, which suits a dashboard).

**For Tide, build a GPGPU height-field on a 128x128 or 256x256 simulation texture, not a
Navier-Stokes solver.** Three.js ships `GPUComputationRenderer` and a working water example
at exactly that resolution. It has memory, so the four pressure inputs become impulses that
ripple and decay, which is the behaviour you want. A pure noise displacement shader is
cheaper but stateless, and a full stable-fluids solver costs dozens of fullscreen passes per
frame for a look that is closer to ink than to a pressure surface.

**Budget hundreds of thousands of particles for River and Kiln, not thousands, as long as
the per-particle update lives on the GPU.** Three.js ships a 500,000-point example with a
static buffer and a 200,000-particle WebGPU compute example. A CPU-updated buffer is roughly
two orders of magnitude worse, so plan on the low tens of thousands there.

**Nothing here forecloses a raw WebGL or WebGPU instrument.** The hero slot swaps Svelte
components. A raw instrument mounts its own `<canvas>` and never imports Threlte or three.js
at all. That is a stronger guarantee than any interop API.

One colour note that runs through all of this: Daniel is red-green colorblind, so the glow
and displacement channels below are load-bearing. Bloom intensity and wave amplitude are
luminance and shape, which survive colorblindness. Do not add a red-versus-green hue channel
on top of them and call it redundant encoding.

---

## 1. Threlte versus raw three.js under Svelte 5

### State of Svelte 5 support

Threlte 8 is the Svelte 5 line. The migration guide states it plainly: "Threlte 8 adds
Svelte 5 support and removes Svelte 4 support"
([migration guide](https://github.com/threlte/threlte/blob/main/apps/docs/src/content/learn/advanced/migration-guides.mdx)).
The published peer dependencies for `@threlte/core` 8.6.0 and `@threlte/extras` 9.21.1 are
`{"svelte": ">=5", "three": ">=0.160"}`
([npm registry, @threlte/core](https://registry.npmjs.org/@threlte/core)).
Threlte 7 documentation has been moved to a separate `v7.threlte.xyz` site, so the current
docs are the Svelte 5 docs
([introduction](https://threlte.xyz/docs/learn/getting-started/introduction)).

The runes integration is not a wrapper. Threlte's own hooks are implemented in rune modules:
`useFBO.svelte.ts`, `useCursor.svelte.ts`, `useViewport.svelte.ts` and others carry the
`.svelte.ts` extension that only makes sense for rune-backed state
([packages/extras/src/lib/hooks](https://github.com/threlte/threlte/tree/main/packages/extras/src/lib/hooks)).
The plugin API was rewritten for the same reason: "The plugin API has been changed to allow
for greater granularity and a reactivity model that is in-line with Svelte 5," and the old
`onPropsChange` / `onRefChange` callbacks were replaced by a single reactive `args` object
([migration guide](https://github.com/threlte/threlte/blob/main/apps/docs/src/content/learn/advanced/migration-guides.mdx)).

### Does the reactivity fight an imperative render loop

No, and this is the part that actually matters for the hero slot. Threlte's default render
mode is `'on-demand'`: it renders only when a frame is invalidated, and it invalidates
automatically when a `<T>` component's props change or a component mounts or unmounts
([render modes](https://github.com/threlte/threlte/blob/main/apps/docs/src/content/learn/basics/render-modes.mdx)).
For an instrument that animates every frame, `useTask` invalidates on every frame by default,
which gets you a continuous loop with no extra wiring. For an instrument that owns its own
pipeline, `<Canvas>` exposes `autoRender`, documented as "Whether to automatically render the
scene every frame. Set to `false` to implement custom render pipelines"
([`<Canvas>` reference](https://github.com/threlte/threlte/blob/main/apps/docs/src/content/reference/core/canvas.mdx)).

Threlte's own outline example is the template for that, and it is worth copying almost
verbatim for your post-processed instruments. It pulls `scene`, `renderer`, `camera`, `size`,
`autoRender` and `renderStage` out of `useThrelte()`, sets `autoRender` to false inside an
`$effect` (restoring the previous value on teardown), builds a `postprocessing`
`EffectComposer`, and drives it from
`useTask((delta) => composer.render(delta), { stage: renderStage, autoInvalidate: false })`
([CustomRenderer.svelte](https://github.com/threlte/threlte/blob/main/apps/docs/src/examples/postprocessing/outline/CustomRenderer.svelte)).
That is a clean escape hatch, not a fight. The `autoInvalidate: false` is the detail people
miss: without it the custom render task would keep invalidating on-demand frames forever.

There is also a task scheduler underneath, with named stages and explicit dependencies
between tasks, so "advance the simulation, then update instance matrices, then render" is
expressible declaratively rather than as ordering luck in one giant `requestAnimationFrame`
([useTask](https://github.com/threlte/threlte/blob/main/apps/docs/src/content/reference/core/use-task.mdx)).
With five instruments sharing one canvas and one of them being a black screen, that
scheduling is genuinely worth having.

### What `@threlte/extras` covers today

The component list in `@threlte/extras` 9.21.1 is large and several entries map directly onto
your five instruments:
`Instancing`, `PointsMaterial`, `Sparkles`, `Stars`, `Sky`, `GradientTexture`, `MeshLine`,
`Outlines`, `FakeGlowMaterial`, `Mask`, `HUD`, `View`, `Text`, `Text3DGeometry`,
`AsciiRenderer`, `ContactShadows`, `SoftShadows`, `CSM`, `Billboard`, `Float`, `Wobble`,
`Grid`, `CameraControls`, `PerfMonitor`
([packages/extras/src/lib/components](https://github.com/threlte/threlte/tree/main/packages/extras/src/lib/components)).
`HUD` and `View` matter for a dashboard with overlay chrome, `PerfMonitor` matters for
holding a 60fps budget honestly, and `AsciiRenderer` is a ready-made aesthetic if the black
screen instrument ever wants to become semi-legible.

**It does not include post-processing.** The monorepo publishes exactly eight packages
(`core`, `extras`, `flex`, `gltf`, `rapier`, `studio`, `theatre`, `xr`)
([packages/](https://github.com/threlte/threlte/tree/main/packages)) and there is no
`@threlte/postprocessing` on npm. Threlte's answer is to use the `postprocessing` library
directly inside a custom renderer component, which is what its two documented
post-processing examples do
([examples/postprocessing](https://github.com/threlte/threlte/tree/main/apps/docs/src/content/examples/postprocessing)).
A third-party `threlte-postprocessing` wrapper exists but is not maintained by the Threlte
team and is not needed: the raw pattern is about forty lines.

### Maintenance and release cadence

Healthy and current. Releases through 2026: `@threlte/core` 8.5.10 through 8.5.16 between
late April and late May, then 8.6.0 on 2026-08-26, with `@threlte/extras` 9.21.1 on the same
day. `@threlte/rapier` 3.5.0 landed 2026-05-25 and `@threlte/xr` 1.6.1 on 2026-05-09
([npm registry timestamps](https://registry.npmjs.org/@threlte/core),
[GitHub releases](https://github.com/threlte/threlte/releases)). The repository's last push
was 2026-09-15, one day before this research, with 70 open issues against 3,338 stars. There
is a `8.0.0-next.41` prerelease tag alongside stable 8.6.0, which is normal for this project.

Two honest caveats. First, releases are bursty: there was a three-month gap between
2026-05-25 and 2026-08-26 with no `@threlte/core` release, so if three.js ships something you
need on day one you may be ahead of Threlte. The open-ended `three: ">=0.160"` peer range
means a three.js upgrade will not be blocked by Threlte's own metadata, which cuts both ways.
Second, `@threlte/studio` is on 0.4.3 from 2026-04-08 and has not moved since; it is not on
the critical path here but do not plan around it.

### Verdict

Take Threlte, for three concrete reasons rather than "it's nicer."

1. You have five instruments that mount and unmount at runtime. Threlte's `<T>` component
   handles scene-graph attach and detach, and automatic disposal is scoped to objects a `<T>`
   actually references (a deliberate Threlte 8 change to make disposal predictable and to
   remove a performance bottleneck, per the migration guide). Writing correct add, remove,
   and dispose for five hot-swappable scenes by hand is where a raw three.js build leaks GPU
   memory, and it leaks silently.
2. On-demand rendering is the default. Four of your five instruments are ambient, and the
   black-screen instrument should cost nothing. Threlte gives you "render only when something
   changed" for free, and `prefers-reduced-motion` then becomes "do not start the task"
   rather than a special case threaded through a hand-rolled loop.
3. The escape hatch is documented and first-class, so choosing Threlte does not pre-commit
   any individual instrument to it.

The cost is real but small: one more dependency that trails three.js releases by weeks, and
one more abstraction to learn. Given that four of the five instruments are scene-graph shaped
and one is not, that trade lands clearly in Threlte's favour.

---

## 2. Post-processing and selective bloom in three.js today

### EffectComposer is still shipped, and still an example

`EffectComposer` lives in `examples/jsm/postprocessing/` alongside 30 other passes including
`UnrealBloomPass`, `OutputPass` and `SMAAPass`
([examples/jsm/postprocessing](https://github.com/mrdoob/three.js/tree/dev/examples/jsm/postprocessing)),
and the API docs still describe it as the way to do post-processing, imported from
`three/addons/postprocessing/EffectComposer.js`, with the note "This module can only be used
with WebGLRenderer" and no deprecation warning
([EffectComposer docs](https://threejs.org/docs/pages/EffectComposer.html)).
It is maintained, not deprecated. But it is an addon, every pass is its own fullscreen draw,
and three.js's own investment has moved elsewhere.

### Where three.js core is actually going

The core post-processing story is now node-based and WebGPU-only. `PostProcessing` was
deprecated in r183 in favour of `RenderPipeline`
([PostProcessing docs](https://threejs.org/docs/pages/PostProcessing.html)), and
`RenderPipeline` imports from `three/webgpu`, composes effects as TSL nodes assigned to an
`outputNode`, and is explicitly documented as usable only with `WebGPURenderer`, not
`WebGLRenderer` ([RenderPipeline docs](https://threejs.org/docs/pages/RenderPipeline.html)).
So core's modern answer does not apply to a WebGL build. If you are on `WebGLRenderer`, your
choice is `EffectComposer` or the `postprocessing` library.

### Use the `postprocessing` library

`postprocessing` 6.39.5 shipped 2026-09-09, one day after three.js r186, with the peer range
`three >= 0.168.0 < 0.187.0`
([release notes](https://github.com/pmndrs/postprocessing/releases),
[npm registry](https://registry.npmjs.org/postprocessing)). That turnaround is the strongest
single signal about its maintenance: vanruesc tracks three.js releases within days. The
repository had 30 open issues and a push on 2026-09-12.

The technical argument is in its README: `EffectPass` "automatically organizes and merges any
given combination of effects. This minimizes the amount of render operations and makes it
possible to combine many effects without the performance penalties of traditional pass
chaining," and every fullscreen operation uses a single screen-filling triangle rather than a
quad ([README](https://github.com/pmndrs/postprocessing#performance)). For a dashboard where
one instrument might want bloom plus vignette plus a subtle scanline, that is the difference
between one fullscreen pass and three.

Two configuration facts from the README worth writing down now, because getting them wrong
later means re-tuning every instrument's colours:

- Construct the renderer with `{ powerPreference: "high-performance", antialias: false,
  stencil: false, depth: false }` and get antialiasing from an `SMAAEffect` in the chain.
- Set `renderer.toneMapping = NoToneMapping`, build the composer with
  `{ frameBufferType: HalfFloatType }`, and put a `ToneMappingEffect` at the end of the
  chain. The README is explicit that low-precision sRGB buffers clamp to `[0,1]` and shift
  information loss into the dark end, "which leads to noticable banding in dark scenes." Your
  dashboard is a full-screen dark scene, so this is not optional.

There is a v7 line (`7.0.0-beta.16`, 2026-02-19) that has not moved in seven months while 6.x
keeps shipping. **Use 6.x.** I could not find a maintainer statement dating a v7 release or
committing to WebGPU support; the only WebGPU discussion I located in the repository is a
2024 user question with no roadmap answer
([discussions](https://github.com/pmndrs/postprocessing/discussions)). Treat v7 and WebGPU
support in this library as unverified.

### Selective bloom

Three.js's own approach is a hack, and it is instructive to see why. The
`webgl_postprocessing_unreal_bloom_selective` example uses a `Layers` mask, runs a first
`EffectComposer` to a render target with everything non-glowing swapped to a shared black
`MeshBasicMaterial`, then runs a second `EffectComposer` with a custom `ShaderPass` that
additively mixes the bloom texture back over a normal render
([example source](https://github.com/mrdoob/three.js/blob/dev/examples/webgl_postprocessing_unreal_bloom_selective.html)).
Two full scene renders per frame, plus a material swap and restore walk over the scene graph
every frame. That is a lot of cost and a lot of bookkeeping for a dashboard that swaps its
whole scene at runtime.

`postprocessing` ships `SelectiveBloomEffect`, documented in-source as "A selective bloom
effect. This effect applies bloom to selected objects only." It extends `BloomEffect`, adds
the `DEPTH` effect attribute, and isolates the glowing set with a `DepthPass` plus a
`DepthMaskMaterial` in `EqualDepth` mode rather than by re-rendering the scene twice with
swapped materials
([SelectiveBloomEffect.js](https://github.com/pmndrs/postprocessing/blob/main/src/effects/SelectiveBloomEffect.js)).
You drive it through a `Selection` set, which is the same API as `OutlineEffect.selection`,
and the Threlte outline example shows the exact Svelte 5 lifecycle for it:

```ts
$effect(() => {
  effect.selection.add(mesh)
  return () => effect.selection.clear()
})
```

([CustomRenderer.svelte](https://github.com/threlte/threlte/blob/main/apps/docs/src/examples/postprocessing/outline/CustomRenderer.svelte)).
Swap `OutlineEffect` for `SelectiveBloomEffect` and you have per-object glow driven by Svelte
state, which is precisely what "this event is overdue, make it glow" needs.

The colorblindness point lands here. Glow is a luminance channel and it reads for everyone,
so selective bloom is a good primary encoding for status, better than colour. But it only
carries one dimension (more glow or less), so the state it encodes has to be ordinal:
urgency, heat, staleness. A categorical state (queued versus failed versus done) needs shape
or position or a label, not a second hue. `@threlte/extras` ships `Outlines` and `Text`,
which are the natural second channel.

---

## 3. Progressive web app installability in current Chrome on macOS

### What changed, and when

Chrome removed the service-worker-with-a-`fetch()`-handler requirement for installation from
the menu in **version 108 on mobile and version 112 on desktop**. Chrome's own post says it
"removed the requirement to have a service worker that implements the `fetch()` method for
installation from the menu," and that the team also shipped "a default custom page for sites
that don't implement their own" offline experience
([Revisiting Chrome's installability criteria](https://developer.chrome.com/blog/update-install-criteria),
last updated 2023-12-05). That is the last change to the requirement, so it has been stable
for over three years. The same post notes the PWA category was removed from Lighthouse,
which is why the Lighthouse installability docs are now the wrong place to look even though
they still list the manifest fields correctly.

MDN, last modified **2026-09-07**, nine days before this research, is the freshest primary
statement and says directly: "While not a requirement for a PWA to be installable, many PWAs
use service workers to provide an offline experience"
([Making PWAs installable](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable)).

### The exact minimum

For Chromium-based browsers, per MDN (2026-09-07) and web.dev's Chrome-specific criteria
article (2024-09-19):

- **Secure context.** HTTPS, or `localhost` or `127.0.0.1`, with or without a port number.
  MDN states the loopback exemption explicitly, so your loopback-only dashboard qualifies
  with no certificate work. web.dev's article says only "Be served over HTTPS," which reads
  as a conflict but is not: it is the general statement, and the loopback exemption is the
  standing secure-context rule.
- **A web app manifest** containing:
  - `name` or `short_name`
  - `icons` including a **192x192** and a **512x512** icon
  - `start_url`
  - `display` set to one of `fullscreen`, `standalone`, `minimal-ui`, or
    `window-controls-overlay` (MDN phrases this as `display` and/or `display_override`)
  - `prefer_related_applications` absent or `false`
- **No service worker, and no fetch handler.**
- **Not already installed.**
- **User engagement.** web.dev lists a heuristic: the user has clicked or tapped the page at
  least once and spent at least 30 seconds on it. This gates the promoted install prompt, not
  installation itself; the install control in the omnibox and the browser menu is available
  regardless.

Sources: [MDN, Making PWAs installable](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable),
[web.dev, What does it take to be installable?](https://web.dev/articles/install-criteria).

### What this means for the dashboard

Write a five-field manifest and two PNGs and you are done. Do not write a service worker for
installability. Write one only if you want the dashboard to open when the Hono server is
down, which for a loopback-only tool is a real question with a real answer either way but is
not an install requirement.

`display: "window-controls-overlay"` is worth considering over `"standalone"`. It is on
Chrome's accepted list and it gives the full-screen dark instrument the title-bar strip back,
which on a hero-slot dashboard is usable area rather than chrome. It also needs the
`window-controls-overlay` CSS environment variables handled, so treat it as a later polish
pass, not a day-one choice.

One thing I could not verify from a dated primary source: whether current Chrome on macOS
shows the omnibox install icon for a `http://127.0.0.1:PORT` origin specifically, as opposed
to `http://localhost:PORT`. MDN lists both as acceptable. Test it in the browser rather than
trusting this document.

---

## 4. Tide: a full-screen 2D fluid or wave surface from four numbers

Four approaches, cheapest first.

### A. Noise-driven displacement shader

A fullscreen quad or a subdivided plane, displaced by layered or domain-warped simplex noise,
with the four pressure inputs feeding amplitude, frequency, warp strength and drift speed.
One fragment pass per frame, no state, no render targets. Three.js ships `SimplexNoise` as an
addon ([math/SimplexNoise.js](https://github.com/mrdoob/three.js/tree/dev/examples/jsm/math)),
and `webgl_points_waves` is the minimal shape of this idea in the examples
([source](https://github.com/mrdoob/three.js/blob/dev/examples/webgl_points_waves.html)).

Cost: effectively free, one pass. Quality: it can look genuinely beautiful, and domain warping
gives you convincing large-scale motion. Limitation: it has no memory. A change in pressure
retargets the noise parameters and the whole surface morphs toward the new look. It cannot
show a ripple travelling outward from an event, because nothing propagates.

This is the right implementation of the `prefers-reduced-motion` variant of Tide: freeze
time, evaluate the noise field once at the current pressures, and render a still.

### B. GPGPU height-field on a simulation texture (recommended)

A ping-ponged float render target holding height and velocity, advanced by a discrete wave
equation with a damping term, then used as a displacement and normal source for the visible
surface. Three.js ships `GPUComputationRenderer` as an addon and a complete working example:
`webgl_gpgpu_water` runs a **128x128** simulation texture over a 6-unit pool with tunable
`viscosity`, `mouseSize` and `mouseDeep`, and it reads the water level back for floating
objects ([source](https://github.com/mrdoob/three.js/blob/dev/examples/webgl_gpgpu_water.html),
[GPUComputationRenderer](https://github.com/mrdoob/three.js/blob/dev/examples/jsm/misc/GPUComputationRenderer.js)).

Cost: one or two small fullscreen passes per frame at 128x128 or 256x256, which is negligible
regardless of display resolution because the simulation grid is decoupled from the screen.
Quality: high, and crucially it has memory. Your four pressure inputs become forces on the
field: sustained displacement raises a region, a spike drops an impulse that ripples outward
and decays. That reads as pressure to a viewer in a way noise cannot fake.

This is the recommendation. It is the best ratio of look to cost for "respond to four
numbers," and the reference implementation is in the three.js repository rather than in a
blog post, so it is maintained alongside the library.

### C. Stable-fluids Navier-Stokes on the GPU

The Jos Stam stable-fluids scheme: advect the velocity field, compute divergence, solve for
pressure with 20 to 50 Jacobi iterations, subtract the gradient, advect a dye field. The
reference WebGL implementation everyone starts from is Pavel Dobryakov's
[WebGL-Fluid-Simulation](https://github.com/PavelDoGreat/WebGL-Fluid-Simulation), MIT
licensed, 16.6k stars, but note its last push was **2024-11-12**: it works, it is not
actively developed, and you would be vendoring it rather than depending on it.

Cost: the pressure solve dominates. Each Jacobi iteration is a fullscreen pass on the
simulation grid, so a 40-iteration solve is 40+ passes per frame plus advection and boundary
passes. At a reduced simulation resolution (256x256 or 512x512) this still hits 60fps on
Apple Silicon, which is why the demo runs on phones, but it is one to two orders of magnitude
more GPU work than option B for the same frame.

Quality: the highest of the WebGL options, and distinctly different. Real advection produces
swirling, ink-in-water, curling filaments. Ask whether that is Tide. "Pressure surface" reads
as a taut membrane with standing waves, which is option B. Ink dispersal is a different
instrument, and it would be a good one, but it is not the one described.

### D. WebGPU compute particle fluid

Three.js ships `webgpu_compute_particles_fluid`, described in the page itself as "MLS-MPM
particle simulation running in compute shaders," with a default of `8192 * 4` (32,768)
particles, a `maxParticles` of `8192 * 16` (131,072), and a 64-cell grid
([source](https://github.com/mrdoob/three.js/blob/dev/examples/webgpu_compute_particles_fluid.html)).

Cost: highest, and WebGPU-only in practice. Quality: genuinely three-dimensional fluid with
splashing and surface tension. Not the right first implementation of Tide, but a good
argument for keeping the WebGPU door open (see question 6).

### Verdict

Build B. Use A for the reduced-motion still and as the fallback if a device reports no float
render target support. Keep C in mind as a separate future instrument rather than as a
better Tide.

On colour: map the four pressures to displacement amplitude, wave frequency, damping, and
specular sharpness, not to hue. A red-versus-green pressure gradient would be the single
worst encoding available here, and it is also the default one people reach for. If Tide needs
a categorical readout on top of the surface, put a labelled contour line or a marker on it.

---

## 5. Particle counts at 60fps on Apple Silicon

I could not find a dated primary benchmark that states a particle count and a frame rate on
specific Apple Silicon hardware. Nobody authoritative publishes that number, because it moves
with point size, overdraw, blending, and pixel ratio. What the three.js repository does give
you is the counts the maintainers ship as examples, which are chosen to run smoothly on
ordinary laptop hardware. Treat these as the order of magnitude and profile for real.

| Approach | Count in the shipped three.js example |
|---|---|
| Static buffer, `Points` | **500,000** ([webgl_buffergeometry_points](https://github.com/mrdoob/three.js/blob/dev/examples/webgl_buffergeometry_points.html)) |
| Custom shader on `Points`, one CPU-updated attribute per frame | **100,000** ([webgl_buffergeometry_custom_attributes_particles](https://github.com/mrdoob/three.js/blob/dev/examples/webgl_buffergeometry_custom_attributes_particles.html)) |
| GPGPU position and velocity textures | **4,096** (64x64) for an N-body solve ([webgl_gpgpu_protoplanet](https://github.com/mrdoob/three.js/blob/dev/examples/webgl_gpgpu_protoplanet.html)), **1,024** (32x32) for flocking with per-bird geometry ([webgl_gpgpu_birds](https://github.com/mrdoob/three.js/blob/dev/examples/webgl_gpgpu_birds.html)) |
| WebGPU compute, sprite particles | **200,000** ([webgpu_compute_particles](https://github.com/mrdoob/three.js/blob/dev/examples/webgpu_compute_particles.html)) |
| `InstancedMesh` with real geometry | slider capped at **10,000** ([webgl_instancing_performance](https://github.com/mrdoob/three.js/blob/dev/examples/webgl_instancing_performance.html)) |

The two GPGPU numbers look low but are not evidence against the approach: those simulations
are O(N²) per particle, so they are compute-bound by the physics, not by the particle count.
A River whose motion is a closed-form function of time and a per-particle seed has no such
constraint.

Read the table this way:

- **Points with a vertex shader that computes motion from `time` and per-particle attributes:
  hundreds of thousands.** 500k is a shipped example. Plan River at **100,000 to 300,000** and
  expect headroom.
- **Points with a CPU-updated attribute uploaded every frame: tens of thousands.** The example
  that does this uses 100,000 with a single scalar attribute (`size`, marked
  `DynamicDrawUsage`). Updating three floats of position per particle per frame is three times
  the upload and adds a JavaScript loop, so **10,000 to 50,000** is the honest band.
- **`InstancedMesh` with actual geometry: low tens of thousands at most**, and the ceiling is
  vertex count and overdraw, not instance count. Kiln's embers should be `Points` with a
  shader, not instanced meshes, unless each ember genuinely needs to be a shaped solid.

So: River and Kiln are **hundreds of thousands** of particles, on the condition that per-frame
state lives entirely in the vertex shader or in a GPGPU texture. The moment a JavaScript loop
touches every particle each frame, the budget drops by roughly two orders of magnitude. That
is the actual decision, not the number.

Caveat stated plainly: these are example sizes, not measured frame rates on an M-series
MacBook Pro. Build a throwaway page that ramps the count with the example's own `Stats` panel
before committing either instrument's design to a number.

---

## 6. Does any of this foreclose a raw WebGL or WebGPU instrument

No, and the reason is structural rather than about any API.

### The hero slot is a component boundary, not a renderer

Instruments swap at runtime, which means the slot renders one Svelte component at a time. A
Threlte instrument mounts `<Canvas>` and a scene. A raw WebGL instrument mounts its own
`<canvas>` element, calls `getContext('webgl2')`, and runs its own loop. It imports neither
Threlte nor three.js. Nothing in Threlte is a global, an app-level plugin, or a build-time
transform: `<Canvas>` "provides contexts that all other components and many hooks depend on,"
and those are Svelte contexts scoped to the component subtree
([`<Canvas>` reference](https://github.com/threlte/threlte/blob/main/apps/docs/src/content/reference/core/canvas.mdx)).
Outside the subtree, Threlte does not exist.

Keep this true by writing the instrument contract as `{ mount(container), destroy() }` or as a
plain Svelte component with no Threlte types in its props. The moment the contract mentions a
three.js `Scene` or a Threlte context, you have closed the door. That is the only real risk
here, and it is a design decision you make in the first hour, not a library constraint.

### If you want a raw instrument inside the shared canvas anyway

You can, but you do not need to, and mixing raw GL calls into a renderer that caches GPU state
is where bugs come from. If you ever do, `WebGLRenderer.resetState()` exists precisely to
resynchronise three.js's cached state after foreign GL calls, and r186 added `resetState()` to
the new `Renderer` as well
([r186 release notes](https://github.com/mrdoob/three.js/releases)). Prefer a separate canvas.

### WebGPU

Threlte already supports it. `@threlte/core` ships a `webgpu` export that "mirrors the regular
library but swaps the default renderer for `WebGPURenderer`, awaits `renderer.init()`
internally, and points `<T>` at `three/webgpu` so node materials resolve out of the box," and
`<Canvas>` takes a `createRenderer` factory if you need to configure the backend yourself
([WebGPU and TSL](https://github.com/threlte/threlte/blob/main/apps/docs/src/content/learn/advanced/webgpu.mdx)).
WebGPU has been available by default in Chrome on macOS since Chrome 113 in 2023
([Chrome ships WebGPU](https://developer.chrome.com/blog/webgpu-release)), so on your target
platform it is simply available.

Two practical notes from Threlte's own WebGPU page. First, `WebGPURenderer` falls back to
WebGL when WebGPU is unavailable, so a WebGPU instrument degrades rather than failing. Second,
WebGPU uses top-level `await` for capability detection and Vite will error on it unless you
set `optimizeDeps.esbuildOptions.target` and `build.target` to `'esnext'`. Put those two lines
in `vite.config.ts` now even though nothing needs them yet; they cost nothing and they remove
a confusing failure later.

### The one thing that does constrain you

Post-processing does not cross the WebGL/WebGPU line. The `postprocessing` library is a
`WebGLRenderer` library, and three.js's node-based `RenderPipeline` is documented as
"`WebGPURenderer` only"
([RenderPipeline docs](https://threejs.org/docs/pages/RenderPipeline.html)). A WebGPU
instrument would rebuild its effect chain in TSL rather than porting `EffectPass` code. Since
each instrument owns its own pipeline anyway (that is the point of `autoRender={false}`), this
is per-instrument rework, not a migration. It is also the reason not to build a shared
"post-processing service" across instruments: that abstraction would be the thing that
actually forecloses WebGPU later.

---

## Sources

Version and release data pulled 2026-09-16 from
[registry.npmjs.org](https://registry.npmjs.org/@threlte/core) and the GitHub REST API for
[threlte/threlte](https://github.com/threlte/threlte),
[pmndrs/postprocessing](https://github.com/pmndrs/postprocessing) and
[mrdoob/three.js](https://github.com/mrdoob/three.js). Documentation quotes are linked inline
at the claim they support.

Unverified, flagged in place: the status and timeline of `postprocessing` v7 and its WebGPU
plans; whether Chrome on macOS promotes install for a bare `127.0.0.1` origin as readily as
for `localhost`; and any measured particle-count-versus-frame-rate figure on specific
M-series hardware.
