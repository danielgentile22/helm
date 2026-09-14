<script lang="ts">
  import type { ThreadId } from "../../shared/protocol";
  import { router } from "../route.svelte";

  let { to, toTitle }: { to: ThreadId; toTitle: string } = $props();

  const href = $derived(`/t/${to}`);

  function open(e: MouseEvent): void {
    // A modifier or middle click is the reader asking for a new tab; only a plain left click is ours to take.
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    router.navigate(href);
  }
</script>

<a class="forkto" {href} onclick={open}>Forked to {toTitle} <span aria-hidden="true">›</span></a>
