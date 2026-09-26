<script lang="ts">
  let { outcome, error }: { outcome: "interrupted" | "error" | "orphaned"; error: string | null } = $props();
</script>

{#if outcome === "interrupted"}
  <div class="endline"><span class="glyph">◼</span>stopped</div>
{:else if outcome === "error"}
  <div class="endline bad"><span class="glyph">▲</span>turn failed · {error ?? "no reason given"}</div>
{:else}
  <div class="endline bad"><span class="glyph">⊘</span>orphaned · the server restarted while this turn was running</div>
{/if}
