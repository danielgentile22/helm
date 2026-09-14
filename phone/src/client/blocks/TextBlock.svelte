<script lang="ts">
  import { renderMarkdown } from "../markdown";
  import TextActions from "../sheets/TextActions.svelte";

  let { text, streaming, onQuote, onFork = null }: { text: string; streaming: boolean; onQuote: (quoted: string) => void; onFork?: (() => void) | null } = $props();

  const html = $derived(renderMarkdown(text));

  const HOLD_MS = 500;
  const DRIFT_PX = 10;

  let el: HTMLDivElement | null = $state(null);
  let sheetOpen = $state(false);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let origin: { x: number; y: number } | null = null;

  function cancel(): void {
    if (timer) clearTimeout(timer);
    timer = null;
    origin = null;
  }

  function hold(e: PointerEvent): void {
    // A tap that lands on a link or a copy button is a tap, not a long press.
    if ((e.target as HTMLElement | null)?.closest("a, button")) return;
    origin = { x: e.clientX, y: e.clientY };
    timer = setTimeout(() => {
      timer = null;
      sheetOpen = true;
    }, HOLD_MS);
  }

  function openActions(e: Event): void {
    e.preventDefault();
    cancel();
    sheetOpen = true;
  }

  function drift(e: PointerEvent): void {
    if (!origin) return;
    if (Math.abs(e.clientX - origin.x) > DRIFT_PX || Math.abs(e.clientY - origin.y) > DRIFT_PX) cancel();
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="md"
  class:is-streaming={streaming}
  bind:this={el}
  onpointerdown={hold}
  onpointermove={drift}
  onpointerup={cancel}
  onpointercancel={cancel}
  oncontextmenu={openActions}
>{@html html}</div>

{#if sheetOpen}
  <TextActions markdown={text} plain={el?.innerText ?? text} {onQuote} {onFork} onClose={() => (sheetOpen = false)} />
{/if}
