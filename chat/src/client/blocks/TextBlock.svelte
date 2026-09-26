<script lang="ts">
  import { hold } from "../gestures";
  import { renderMarkdown } from "../markdown";
  import TextActions from "../sheets/TextActions.svelte";

  let { text, streaming, onQuote, onFork = null }: { text: string; streaming: boolean; onQuote: (quoted: string) => void; onFork?: (() => void) | null } = $props();

  const html = $derived(renderMarkdown(text));

  let el: HTMLDivElement | null = $state(null);
  let sheetOpen = $state(false);
</script>

<div class="md" class:is-streaming={streaming} bind:this={el} use:hold={() => (sheetOpen = true)}>{@html html}</div>

{#if sheetOpen}
  <TextActions markdown={text} plain={el?.innerText ?? text} {onQuote} {onFork} onClose={() => (sheetOpen = false)} />
{/if}
