<script lang="ts">
  import { undo } from "$lib/undo.svelte";
</script>

<!-- The undo window, inline in the header because nothing floats but the drawer. The filled
     square is the shape of done, so the line reads without its colour. -->
{#if undo.banner !== null}
  <span class="undo" role="status">
    <span class="s">■</span><span class="w">done:</span><span class="l" title={undo.banner.label}>{undo.banner.label}</span>
    {#if undo.banner.more > 0}<span class="more">+{undo.banner.more} more</span>{/if}
    <button onclick={() => undo.undoLast()}><kbd>u</kbd> undo</button>
    <span class="left">{undo.banner.seconds}s <span class="w">left</span></span>
  </span>
{/if}
