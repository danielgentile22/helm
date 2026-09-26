<script lang="ts">
  import { toolSummary } from "../../shared/protocol";
  import type { ToolItem } from "../../shared/turns";
  import { toolDiff } from "../transcript";
  import Diff from "./Diff.svelte";

  let { tool, denied = false }: { tool: ToolItem; denied?: boolean } = $props();

  const OUTPUT_LINES = 200;

  let open = $state(false);
  let showAll = $state(false);

  const mark = $derived(denied ? { cls: "denied", glyph: "⊘", word: "denied" } : tool.isError === null ? { cls: "running", glyph: "◆", word: "running" } : tool.isError ? { cls: "error", glyph: "▲", word: "failed" } : { cls: "done", glyph: "✓", word: "done" });
  const summary = $derived(toolSummary(tool.name, tool.input));
  const diff = $derived(toolDiff(tool));
  const input = $derived(typeof tool.input === "string" ? tool.input : JSON.stringify(tool.input, null, 1));
  const outputLines = $derived(tool.output === null ? [] : tool.output.split("\n"));
  const clipped = $derived(!showAll && outputLines.length > OUTPUT_LINES);
  const output = $derived(clipped ? outputLines.slice(0, OUTPUT_LINES).join("\n") : outputLines.join("\n"));
</script>

<div class="trow" class:is-open={open}>
  <button class="trhead" type="button" aria-expanded={open} onclick={() => (open = !open)}>
    <span class="state {mark.cls}"><span class="glyph">{mark.glyph}</span>{mark.word}</span>
    <span class="name">{summary.label}</span>
    <span class="arg">{summary.arg}</span>
  </button>
  {#if open}
    {#if diff}
      <Diff file={diff.file} lines={diff.lines} />
    {:else}
      <pre class="io">{input}</pre>
    {/if}
    {#if tool.output !== null}
      <pre class="io">{output}</pre>
      {#if clipped}
        <button class="btn small" type="button" onclick={() => (showAll = true)}>show all {outputLines.length} lines</button>
      {/if}
    {/if}
  {/if}
</div>
