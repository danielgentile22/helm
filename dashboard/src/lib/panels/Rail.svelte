<script lang="ts">
  import { segments } from "$lib/model/ink";
  import type { Placed } from "$lib/model/pressure";

  // A rail is the pull drawn as a length: one segment per open thing, strongest first, on
  // the board's one scale (--ppp, pixels per unit of pull, set on the map). It never stands
  // alone: the words beside it say what it is made of, so it is hidden from a screen reader.
  type Props = { things: readonly Placed[] };
  const { things }: Props = $props();

  const segs = $derived(segments(things));
</script>

{#if segs.length > 0}
  <span class="rail" aria-hidden="true">
    {#each segs as seg, i (i)}
      <i class={seg.tone} style="--pull:{seg.pull}"></i>
    {/each}
  </span>
{/if}
