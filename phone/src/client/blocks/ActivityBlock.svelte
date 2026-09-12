<script lang="ts">
  import { fmtDuration, toolArg } from "../format";
  import { summarize, type Block } from "../transcript";
  import ToolRow from "./ToolRow.svelte";

  let { block }: { block: Extract<Block, { kind: "activity" }> } = $props();

  let open = $state(false);
  let now = $state(Date.now());

  $effect(() => {
    if (!block.running) return;
    const id = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(id);
  });

  // summarize() writes one sentence; splitting on the digits is what lets the counts
  // carry weight without a second string format to keep in step with it.
  const parts = $derived(summarize(block.counts).split(/(\d+)/));
  const elapsed = $derived(block.running ? now - new Date(block.startedAt).getTime() : block.durationMs);
</script>

<div class="act">
  <button class="ahead" type="button" aria-expanded={open} onclick={() => (open = !open)}>
    <span class="chev">{open ? "▾" : "▸"}</span>
    <span class="sum">{#each parts as part, i (i)}{#if i % 2}<b>{part}</b>{:else}{part}{/if}{/each}</span>
    {#if elapsed !== null}<span class="dur">{fmtDuration(elapsed)}</span>{/if}
  </button>
  {#if !open && block.current}
    {@const current = block.current}
    <div class="now">
      <span class="dot pulse"></span>
      <span>{current.name}</span>
      <span class="arg">{toolArg(current.input)}</span>
    </div>
  {/if}
  {#if open}
    {#each block.tools as tool (tool.toolUseId)}<ToolRow {tool} />{/each}
  {/if}
</div>
