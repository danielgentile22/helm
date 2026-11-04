<script lang="ts">
  let { count, label }: { count: number; label: string } = $props();
</script>

{#if count > 0}
  <span class="badge" aria-label="{count} {label}">{count}</span>
{/if}

<style>
  .badge {
    display: inline-block;
    min-width: 16px;
    padding: 0 5px;
    border-radius: 999px;
    background: var(--bad);
    color: #fff;
    font-size: 10px;
    line-height: 16px;
    text-align: center;
  }
</style>
