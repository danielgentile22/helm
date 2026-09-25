<script lang="ts">
  let { text, collapsed, streaming }: { text: string; collapsed: boolean; streaming: boolean } = $props();

  // Once the reader has touched the chevron their choice outlives the auto-collapse.
  let toggled = $state<boolean | null>(null);
  const shown = $derived(toggled ?? !collapsed);
</script>

{#if collapsed}
  <button class="thinking" type="button" aria-expanded={shown} onclick={() => (toggled = !shown)}>
    <span class="chev">{shown ? "▾" : "▸"}</span>
    <span class="t">thought</span>
  </button>
{/if}
{#if shown}
  <div class="think-body" class:is-streaming={streaming}>{text}</div>
{/if}
