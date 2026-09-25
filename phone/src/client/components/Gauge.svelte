<script lang="ts">
  import { fmtK } from "../format";

  let { tokens, limit }: { tokens: number | null; limit: number | null } = $props();

  const pct = $derived(tokens !== null && limit ? Math.min(100, Math.round((tokens / limit) * 100)) : null);
</script>

{#if tokens !== null}
  <span class="gauge" title="context: {fmtK(tokens)} tokens{limit ? ` of ${fmtK(limit)}` : ''}">
    <svg viewBox="0 0 36 36" width="34" height="34" aria-hidden="true">
      <circle class="trk" cx="18" cy="18" r="15.9" fill="none" stroke-width="2.6" />
      <circle class="val" cx="18" cy="18" r="15.9" fill="none" stroke-width="2.6" stroke-dasharray="{pct ?? 0} 100" />
    </svg>
    <span>{pct !== null ? `${pct}%` : fmtK(tokens)}</span>
  </span>
{/if}
