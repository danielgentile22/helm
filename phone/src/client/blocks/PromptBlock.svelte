<script lang="ts">
  import type { PromptLine } from "../transcript";

  let { line, onResend }: { line: PromptLine; onResend: (text: string) => void } = $props();

  const STATE_WORD: Readonly<Record<PromptLine["state"], string>> = {
    pending: "sending",
    queued: "queued",
    started: "",
    dropped: "dropped · the server restarted before this ran",
  };
</script>

<div class="origin">{line.label} ›{#if STATE_WORD[line.state]}<i>{STATE_WORD[line.state]}</i>{/if}</div>
<!-- No whitespace around {line.text}: the element is white-space: pre-wrap, so Svelte's
     collapsed newline would render as a real space. -->
<pre class="prompt-text">{line.text}</pre>
{#if line.uploads.length}<div class="attached">attached: {line.uploads.join(", ")}</div>{/if}
{#if line.state === "dropped"}<div class="resend"><button class="btn small" onclick={() => onResend(line.text)}>Resend</button></div>{/if}
