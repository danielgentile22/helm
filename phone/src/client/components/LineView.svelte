<script lang="ts">
  import type { Line } from "../fold";
  import { fmtK, toolArg } from "../format";

  let { line, onResend }: { line: Line; onResend: (text: string) => void } = $props();

  const promptWho = (state: string): string =>
    state === "pending" ? "sending" : state === "queued" ? "queued" : state === "dropped" ? "dropped: server restarted before this ran" : ">";

  function endText(l: Extract<Line, { kind: "end" }>): string {
    const u = l.usage;
    const stats = u ? ` · ${fmtK(u.inputTokens + u.cacheReadTokens)} in, ${fmtK(u.outputTokens)} out${u.costUsd !== null ? `, $${u.costUsd.toFixed(3)}` : ""}, ${Math.round(u.durationMs / 1000)}s` : "";
    return l.outcome === "ok" ? `done${stats}` : l.outcome === "interrupted" ? `stopped${stats}` : l.outcome === "orphaned" ? "server restarted mid-turn; resend to continue" : `error: ${l.error ?? "unknown"}${stats}`;
  }
</script>

{#if line.kind === "prompt"}
  <!-- No whitespace around {line.text}: .line is white-space: pre-wrap, so Svelte's collapsed newline would render as a real space. -->
  <div class="line prompt {line.state}"><span class="who">[{line.label}] {promptWho(line.state)}</span>{line.text}{#if line.uploads.length}<div class="muted">attached: {line.uploads.join(", ")}</div>{/if}{#if line.state === "dropped"}<div class="resend"><button class="btn small" onclick={() => onResend(line.text)}>Resend</button></div>{/if}</div>
{:else if line.kind === "text"}
  <div class="line text">{line.text}</div>
{:else if line.kind === "thinking"}
  <details class="line thinking"><summary>thinking</summary><div class="body">{line.text}</div></details>
{:else if line.kind === "tool"}
  <details class="line tool">
    <summary>
      <span>{line.name} {toolArg(line.input)}</span>
      {#if line.isError === null}<span class="mark busy">running</span>
      {:else if line.isError}<span class="mark err">✗ failed</span>
      {:else}<span class="mark ok">✓ done</span>{/if}
    </summary>
    <pre>input: {typeof line.input === "string" ? line.input : JSON.stringify(line.input, null, 1)}</pre>
    {#if line.output !== null}<pre>{line.output}</pre>{/if}
  </details>
{:else if line.kind === "end"}
  <div class="line end {line.outcome}">{endText(line)}</div>
{:else if line.kind === "note"}
  <div class="line note">{line.text}</div>
{/if}
