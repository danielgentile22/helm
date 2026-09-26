<script lang="ts">
  import { progress as subProgress } from "$lib/model/detail";
  import Glyph from "./Glyph.svelte";
  import { board } from "$lib/board.svelte";
  import { TIER_AT } from "$lib/model/ink";
  import { ui } from "$lib/ui.svelte";
  import { undo } from "$lib/undo.svelte";
  import { dueSoon, type Placed } from "$lib/model/pressure";

  // `progress` is off on a lead whose detail block already counts its subtasks.
  type Props = { placed: Placed; compact?: boolean; progress?: boolean };
  const { placed, compact = false, progress = true }: Props = $props();

  const thing = $derived(placed.thing);
  const state = $derived(
    placed.pressure.late ? "late"
    : placed.pressure.value === 0 ? "rest"
    // A row set in bone pulls as hard as a tier 2 lead.
    : placed.pressure.value >= TIER_AT[1] ? "hot"
    : "",
  );
  const soon = $derived(dueSoon(placed.pressure));
  const lit = $derived(ui.hovered === thing.id || ui.opened === thing.id);
  // The header names one thing to start with; the map marks the same row so the eye can go
  // from the line to its place. A word, so it reads without the colour.
  const start = $derived(board.start?.thing.id === thing.id);
  const ready = $derived(thing.kind !== "job" && thing.doneWhen?.ok === true);
  const subs = $derived(progress && thing.kind !== "job" ? subProgress(thing.subs) : null);
  const checked = $derived(thing.kind !== "job" && undo.checked(thing));
  const waiting = $derived(thing.kind !== "job" && undo.waiting(thing.todoId));
  const cursor = $derived(board.cursor === thing.id);

  // Bound once at mount, before the effect below first runs, so it need not be reactive.
  let el: HTMLDivElement | undefined;

  // The phone's pages scroll and the desktop map does not, so only the phone brings the
  // cursor's row into view. On the desktop it would scroll a clipped cell's insides instead.
  $effect(() => {
    if (cursor && ui.phone) el?.scrollIntoView({ block: "nearest", behavior: ui.reduced ? "instant" : "smooth" });
  });

  function onToggle(event: Event): void {
    if (thing.kind === "job") return;
    const box = event.currentTarget;
    if (!(box instanceof HTMLInputElement)) return;
    undo.set(thing, box.checked);
  }
</script>

<!-- A row is a group, not a button, because a checkbox may not sit inside a button.
     The title is the button that opens the drawer. -->
<div
  bind:this={el}
  class="row {state} {thing.kind}"
  class:lit
  class:start
  class:soon
  class:cursor
  class:waiting
  role="group"
  aria-label={thing.label}
  data-thing={thing.id}
  onpointerenter={(e) => { if (e.pointerType === "mouse") ui.hover(thing.id); }}
  onpointerleave={() => ui.hover(null)}
>
  {#if thing.kind === "job"}
    <span class="cb"></span>
  {:else}
    <!-- The label is the tick's hit area: 44px square on the phone around an 11px box. -->
    <label class="tick"><input type="checkbox" {checked} aria-label="done: {thing.label}" onchange={onToggle} /></label>
  {/if}
  <Glyph {thing} phase={placed.phase} />
  <!-- Title and reason share a line while both fit; a long title wraps and the reason drops
       under it at the left, so nothing is cut and nothing is read in the drawer only. -->
  <span class="body">
    <button class="t" title={compact ? thing.label : undefined} onclick={() => ui.open(thing.id)}>{thing.label}</button>
    <span class="w">{placed.pressure.reason}{#if ready}{" "}<span class="ready">ready</span>{/if}{#if subs !== null}{" "}<span class="sp" title="{subs.done} of {subs.total} subtasks done">{subs.done === subs.total ? "■" : "□"} {subs.done}/{subs.total}</span>{/if}{#if start}{" "}<span class="start-tag">start</span>{/if}</span>
  </span>
</div>
