<script lang="ts">
  import { board } from "$lib/board.svelte";
  import { glyphFor } from "$lib/model/derive";
  import { dueSoon } from "$lib/model/pressure";
  import { ui } from "$lib/ui.svelte";

  // The one answer to "what should I work on", named. first() already ranks the whole board,
  // so this is the map's own strongest pull read out in a line, never a second ranking.
  const start = $derived(board.start);
  const where = $derived.by(() => {
    if (start === null) return "";
    const thing = start.thing;
    return thing.kind !== "job" && thing.project !== null ? `${thing.dept} · ${thing.project}` : thing.dept;
  });
  const full = $derived(start === null ? "" : `${start.thing.label} · ${where} · ${start.pressure.reason}`);

  function open(): void {
    if (start === null) return;
    // On the phone the sheet closes onto the page the thing lives on, so its marked row is there.
    if (ui.phone) ui.setPage(start.thing.dept);
    ui.open(start.thing.id);
  }
</script>

{#if start === null}
  <span class="start-here none"><b>start</b>nothing pulling</span>
{:else}
  <button
    class="start-here {start.thing.kind}"
    class:late={start.pressure.late}
    class:soon={dueSoon(start.pressure)}
    title={full}
    onclick={open}
  >
    <b>start</b>
    <span class="g">{glyphFor(start.thing, start.phase)}</span>
    <span class="t">{start.thing.label}</span>
    <span class="d">{where}</span>
    <span class="w">{start.pressure.reason}</span>
    <kbd>enter</kbd>
  </button>
{/if}
