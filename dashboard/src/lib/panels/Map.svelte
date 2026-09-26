<script lang="ts">
  import Dept from "./Dept.svelte";
  import Drawer from "./Drawer.svelte";
  import Week from "./Week.svelte";
  import { tick } from "svelte";
  import { board } from "$lib/board.svelte";
  import { railScale } from "$lib/model/ink";
  import { snapshot } from "$lib/snapshot.svelte";
  import { ui } from "$lib/ui.svelte";

  // Size the ink, not the plane. The four corners stay (Work and Chess on top, Projects and
  // Life under them, each half a row) but nothing is sized by pull: every box is as tall as
  // what it holds. The week sits between the two rows and is as tall as its busiest column,
  // the bottom row follows it directly, and whatever height is left falls below the bottom
  // row at the page's foot (ADR 0019, amended). CSS knows how tall the content is. The
  // numbers the map hands down are the rail scale, so a unit of pull is the same length in
  // every rail, and the spare height the departments leave, so the week knows whether it has
  // room to be roomy.
  const ppp = $derived(railScale(board.views.map((v) => v.value)));

  // The ink shrinks before the page scrolls. At its natural size a busy board can be taller
  // than the screen, so the map tries each density in turn and keeps the first that fits:
  // 0 is everything at full size, 1 sets each row on one line (the drawer has the whole
  // title) and drops the lead's notes, 2 also sets every lead a step smaller. The steps
  // are the same for every cell, so the tiers still read against each other. Only a board
  // that does not fit even at 2 scrolls, and the week band gives way to its floor first.
  let el = $state<HTMLDivElement | undefined>(undefined);
  let width = $state(0);
  let height = $state(0);
  let density = $state(0);
  let spare = $state(Infinity);
  let want = $state(0);
  const DENSITIES = [0, 1, 2] as const;
  const BAND_FLOOR = 108;

  $effect(() => {
    void board.views;
    void ui.zoom;
    void width;
    void height;
    void fit();
  });

  // The height the four departments leave for the week: the map's inner height less the
  // taller department of each row. Read after every density step, since a denser board
  // leaves more.
  function measureSpare(): number {
    if (el === undefined) return Infinity;
    const style = getComputedStyle(el);
    const pad = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const depts = [...el.querySelectorAll<HTMLElement>(":scope > .dept")];
    const rowH = (names: readonly string[]): number =>
      Math.max(0, ...depts.filter((d) => names.includes(d.dataset["dept"] ?? "")).map((d) => d.offsetHeight));
    return el.clientHeight - pad - rowH(["Work", "Chess"]) - rowH(["Projects", "Life"]);
  }

  async function fit(): Promise<void> {
    for (const next of DENSITIES) {
      density = next;
      await tick();
      spare = measureSpare();
      await tick();
      if (el === undefined || el.scrollHeight <= el.clientHeight + 1) return;
    }
  }
</script>

<div
  class="map d{density}"
  class:zoomed={ui.zoom !== null}
  style="--ppp:{ppp}; --want:{Math.max(BAND_FLOOR, want)}px"
  bind:this={el}
  bind:clientWidth={width}
  bind:clientHeight={height}
>
  <!-- In the order they are drawn, top row, week, bottom row, so Tab and a screen reader
       read the map as the eye does. The grid areas place them; this only orders them. -->
  {#if board.views.length > 0}
    {#each board.views.slice(0, 2) as view (view.dept)}
      {#if ui.zoom === null || ui.zoom === view.dept}<Dept {view} />{/if}
    {/each}
    {#if ui.zoom === null}
      <div class="band"><Week {spare} bind:want /></div>
    {/if}
    {#each board.views.slice(2) as view (view.dept)}
      {#if ui.zoom === null || ui.zoom === view.dept}<Dept {view} />{/if}
    {/each}
  {:else if snapshot.model !== null}
    <div class="empty">nothing on the board</div>
  {/if}
</div>
<Drawer placed={board.opened} />
