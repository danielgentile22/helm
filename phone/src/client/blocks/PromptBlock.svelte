<script lang="ts">
  import type { UploadId } from "../../shared/protocol";
  import type { PromptLine } from "../transcript";

  let { line, onResend, uploadUrl }: { line: PromptLine; onResend: (text: string) => void; uploadUrl: (uploadId: UploadId) => string } = $props();

  const STATE_WORD: Readonly<Record<PromptLine["state"], string>> = {
    pending: "sending",
    queued: "queued",
    started: "",
    dropped: "dropped · the server restarted before this ran",
  };

  const images = $derived(line.uploads.filter((u) => u.mime.startsWith("image/")));
  const files = $derived(line.uploads.filter((u) => !u.mime.startsWith("image/")));
</script>

<div class="origin">{line.label} ›{#if STATE_WORD[line.state]}<i>{STATE_WORD[line.state]}</i>{/if}</div>
<!-- No whitespace around {line.text}: the element is white-space: pre-wrap, so Svelte's
     collapsed newline would render as a real space. -->
{#if line.text}<pre class="prompt-text">{line.text}</pre>{/if}
{#if images.length}
  <div class="shots">
    {#each images as u (u.uploadId)}<img src={uploadUrl(u.uploadId)} alt={u.name} loading="lazy" />{/each}
  </div>
{/if}
{#if files.length}<div class="attached">attached: {files.map((u) => u.name).join(", ")}</div>{/if}
{#if line.state === "dropped"}<div class="resend"><button class="btn small" onclick={() => onResend(line.text)}>Resend</button></div>{/if}
