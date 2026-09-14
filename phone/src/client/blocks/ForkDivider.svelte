<script lang="ts">
  import type { Seq, ThreadId } from "../../shared/protocol";
  import { router } from "../route.svelte";

  let { from, fromTitle, memory, atSeq }: { from: ThreadId; fromTitle: string | null; memory: "session" | "fresh"; atSeq: Seq | null } = $props();

  const href = $derived(atSeq === null ? `/t/${from}` : `/t/${from}#seq=${atSeq}`);

  function open(e: MouseEvent): void {
    // A modifier or middle click is the reader asking for a new tab; only a plain left click is ours to take.
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    router.navigate(href);
  }
</script>

<div class="forkline">
  <span class="hair" aria-hidden="true"></span>
  <a {href} onclick={open}>Forked from {fromTitle ?? "Untitled"}</a>
  <span class="hair" aria-hidden="true"></span>
</div>
{#if memory === "fresh"}
  <p class="forknote">Claude starts here with no memory of the turns above</p>
{/if}
