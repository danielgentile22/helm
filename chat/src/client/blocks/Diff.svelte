<script lang="ts">
  import { shortPath } from "../format";
  import type { DiffLine } from "../transcript";

  let { file, lines }: { file: string; lines: readonly DiffLine[] } = $props();

  const added = $derived(lines.filter((l) => l.op === "+").length);
  const removed = $derived(lines.filter((l) => l.op === "-").length);
  const cls = (op: DiffLine["op"]): string => (op === "+" ? "add" : op === "-" ? "del" : "");
</script>

<div class="diff">
  <header>
    <span class="glyph">±</span>
    <span class="file">{shortPath(file)}</span>
    <span class="tally">{added} added · {removed} removed</span>
  </header>
  <div class="body"><pre>{#each lines as l, i (i)}<span class="ln {cls(l.op)}" data-m={l.op}>{l.text}</span>{/each}</pre></div>
</div>
