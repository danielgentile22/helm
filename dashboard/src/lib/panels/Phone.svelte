<script lang="ts">
  import Dept from "./Dept.svelte";
  import Drawer from "./Drawer.svelte";
  import QuickAdd from "./QuickAdd.svelte";
  import SourceHealth from "./SourceHealth.svelte";
  import Start from "./Start.svelte";
  import Talk from "./Talk.svelte";
  import Undo from "./Undo.svelte";
  import Week from "./Week.svelte";
  import { board } from "$lib/board.svelte";
  import { talk } from "$lib/talk.svelte";
  import { railScale } from "$lib/model/ink";
  import { PAGES, ui } from "$lib/ui.svelte";

  type Props = { warnings: readonly string[] };
  const { warnings }: Props = $props();

  const BAR_MIN = 6;
  const BAR_RANGE = 22;

  let track = $state<HTMLDivElement | null>(null);
  // The phone's rails are shorter than the desk's: a page is 390 wide.
  const ppp = $derived(railScale(board.views.map((v) => v.value), 150, 12));

  const peak = $derived(Math.max(1, ...board.views.map((v) => v.value)));

  // The first run places the persisted page, so the app does not open mid-slide.
  let first = true;
  $effect(() => {
    const page = ui.page;
    const instant = first || ui.reduced;
    const el = track;
    // Before the snapshot lands the track has no leaves, so a scroll would clamp to zero.
    if (el === null || el.clientWidth === 0 || board.views.length === 0) return;
    const index = PAGES.indexOf(page);
    if (index >= 0 && Math.round(el.scrollLeft / el.clientWidth) !== index) {
      el.scrollTo({ left: index * el.clientWidth, behavior: instant ? "instant" : "smooth" });
    }
    first = false;
  });

  function onScroll(): void {
    const el = track;
    if (el === null || el.clientWidth === 0) return;
    const at = PAGES[Math.round(el.scrollLeft / el.clientWidth)];
    if (at !== undefined && at !== ui.page) ui.setPage(at);
  }

  function down(event: PointerEvent): void {
    const el = event.currentTarget;
    if (el instanceof HTMLElement) el.setPointerCapture(event.pointerId);
    event.preventDefault();
    void talk.press();
  }

  function up(): void {
    talk.release();
  }

  // The phone has no Escape, so the same button that opens the field closes it. On the
  // week's page the line has to name its department.
  function plus(): void {
    if (ui.adding === null) ui.add(ui.pageDept);
    else ui.stopAdding();
  }
</script>

<div class="page">
  <header class="phone">
    <span class="mark">HELM</span>
    <div class="strip" role="tablist">
      {#each board.views as view (view.dept)}
        <button
          class="bar"
          class:on={view.dept === ui.page}
          class:late={view.late > 0}
          role="tab"
          aria-selected={view.dept === ui.page}
          aria-label={view.dept}
          style="width:{BAR_MIN + BAR_RANGE * (view.value / peak)}px"
          onclick={() => ui.setPage(view.dept)}
        ></button>
        <!-- The page on screen, named beside its bar; the tab already says it to a screen reader. -->
        {#if view.dept === ui.page}<span class="name" aria-hidden="true">{view.dept}</span>{/if}
      {/each}
      <!-- The week's page, after the four. Its mark is seven ticks, a week, not a pull bar:
           it has no pull of its own. -->
      {#if board.views.length > 0}
        <button
          class="bar wk"
          class:on={ui.page === "Week"}
          role="tab"
          aria-selected={ui.page === "Week"}
          aria-label="the week"
          onclick={() => ui.setPage("Week")}
        ></button>
        {#if ui.page === "Week"}<span class="name" aria-hidden="true">Week</span>{/if}
      {/if}
    </div>
    <span class="spacer"></span>
    <Undo />
    <SourceHealth {warnings} />
  </header>

  <!-- Always in the grid so its row exists before the snapshot lands; empty until then. -->
  <div class="startline">
    {#if board.today !== null}<Start />{/if}
  </div>

  <!-- A page is its department as tall as it holds. The week across the board is a page of its
       own after the four, shown once rather than repeated under every department, since it
       belongs to none of them. -->
  <div class="track" bind:this={track} onscroll={onScroll} style="--ppp:{ppp}">
    {#each board.views as view (view.dept)}
      <div class="leaf">
        <Dept {view} flow />
      </div>
    {/each}
    {#if board.views.length > 0}
      <div class="leaf week-page">
        <Week flow />
      </div>
    {/if}
  </div>

  <div class="bar-talk">
    {#if ui.adding !== null}<QuickAdd />{/if}
    <Talk />
    <div class="thumbs">
      <button
        class="ptt"
        class:hot={talk.phase.name === "listening"}
        aria-label="hold to talk"
        onpointerdown={down}
        onpointerup={up}
        onpointercancel={up}
        onpointerleave={up}
        oncontextmenu={(e) => e.preventDefault()}
      ><span class="s"></span></button>
      <button
        class="plus"
        aria-label={ui.adding === null ? "add a todo" : "close the new todo"}
        aria-expanded={ui.adding !== null}
        onclick={plus}
      >{ui.adding === null ? "+" : "\u00d7"}</button>
    </div>
  </div>
</div>
<Drawer placed={board.opened} />
