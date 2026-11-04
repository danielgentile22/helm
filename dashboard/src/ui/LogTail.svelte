<script lang="ts">
  import { ageOf } from "../lib/time";

  let {
    lines,
    updated,
    now,
    open = false,
  }: { lines: string[]; updated: string | null; now: number; open?: boolean } = $props();

  // Seeded once from the prop; after that the owner's toggle wins over the next poll.
  // svelte-ignore state_referenced_locally
  let shown = $state(open);
  let box: HTMLPreElement | undefined = $state();

  // The newest line is the one that matters, so the box opens scrolled to the end.
  $effect(() => {
    void lines;
    if (box) box.scrollTop = box.scrollHeight;
  });
</script>

{#if lines.length === 0}
  <p class="faint small none">No log yet</p>
{:else}
  <button class="btn toggle" aria-expanded={shown} onclick={() => (shown = !shown)}>
    {shown ? "Hide log" : "Show log"}
  </button>
  {#if shown}
    <pre bind:this={box}>{lines.join("\n")}</pre>
    {#if updated !== null}<p class="faint small none">log updated {ageOf(updated, now)}</p>{/if}
  {/if}
{/if}

<style>
  .toggle {
    margin-top: 8px;
  }
  pre {
    margin: 8px 0 0;
    padding: 8px 10px;
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 8px;
    font-size: 11px;
    color: var(--dim);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: 320px;
    overflow-y: auto;
  }
  .none {
    margin: 6px 0 0;
  }
</style>
