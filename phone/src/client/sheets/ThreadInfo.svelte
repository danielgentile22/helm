<script lang="ts">
  import type { ThreadSummary } from "../../shared/protocol";
  import Sheet from "../components/Sheet.svelte";
  import { fmtK, fmtTime, shortModel, shortPath } from "../format";
  import type { ThreadView } from "../fold";

  let { view, summary, onClose }: { view: ThreadView; summary: ThreadSummary; onClose: () => void } = $props();

  // The log is the only record of what this thread has run on: every model change
  // left a note behind, and the config carries whatever it is running on now.
  const history = $derived([
    ...view.lines.flatMap((l) => (l.kind === "note" ? [l.text.match(/^(\[[^\]]*\]).*?\b(model set to \S+)/)] : [])).flatMap((m) => (m ? [`${m[1]} ${m[2]}`] : [])),
    `now ${shortModel(summary.config.model)} · ${summary.config.effort}`,
  ]);

  const totals = $derived(summary.usageTotal);
</script>

<Sheet {onClose}>
  <div class="grab"></div>
  <h2>Thread info</h2>
  <div class="info">
    <div class="irow"><span class="k">Working directory</span><span class="v">{shortPath(summary.config.cwd)}</span></div>
    <div class="irow"><span class="k">Created</span><span class="v">{fmtTime(summary.config.createdAt)}</span></div>
    <div class="irow"><span class="k">Session</span><span class="v">{view.sessionId ?? "not bound yet"}</span></div>
    <div class="irow">
      <span class="k">Model</span>
      <span class="v">{#each history as h, i (i)}<span class="hline">{h}</span>{/each}</span>
    </div>
    {#if totals}
      <div class="irow"><span class="k">Input</span><span class="v">{fmtK(totals.inputTokens)}</span></div>
      <div class="irow"><span class="k">Output</span><span class="v">{fmtK(totals.outputTokens)}</span></div>
      <div class="irow"><span class="k">Cache read</span><span class="v">{fmtK(totals.cacheReadTokens)}</span></div>
      <div class="irow"><span class="k">Cache write</span><span class="v">{fmtK(totals.cacheWriteTokens)}</span></div>
    {/if}
  </div>
  <div class="actions">
    <span class="grow"></span>
    <button class="btn" onclick={onClose}>Close</button>
  </div>
</Sheet>
