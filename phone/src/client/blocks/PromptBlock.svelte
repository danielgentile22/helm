<script lang="ts">
  import { VAULT_LABEL, type UploadId } from "../../shared/protocol";
  import { guidanceOf } from "../../shared/vault";
  import type { Prompt } from "../../shared/turns";
  import { hold } from "../gestures";
  import TextActions from "../sheets/TextActions.svelte";

  let {
    prompt,
    onResend,
    onQuote,
    onFork = null,
    uploadUrl,
  }: { prompt: Prompt; onResend: (text: string) => void; onQuote: (quoted: string) => void; onFork?: (() => void) | null; uploadUrl: (uploadId: UploadId) => string } = $props();

  const STATE_WORD: Readonly<Record<Prompt["state"], string>> = {
    pending: "sending",
    queued: "queued",
    started: "",
    dropped: "dropped · the server restarted before this ran",
  };

  // The server owns the save prompt's wording, so the phone shows the action and the one line the person typed, not the whole text.
  const isSave = $derived(prompt.label === VAULT_LABEL);
  const guidance = $derived(isSave ? guidanceOf(prompt.text) : null);

  const images = $derived(prompt.uploads.filter((u) => u.mime.startsWith("image/")));
  const files = $derived(prompt.uploads.filter((u) => !u.mime.startsWith("image/")));
  let sheetOpen = $state(false);
</script>

<div use:hold={() => (sheetOpen = true)}>
  <div class="origin">{prompt.label} ›{#if STATE_WORD[prompt.state]}<i>{STATE_WORD[prompt.state]}</i>{/if}</div>
  <!-- No whitespace around {prompt.text}: the element is white-space: pre-wrap, so Svelte's
       collapsed newline would render as a real space. -->
  {#if isSave}
    <div class="save-row">Save to vault</div>
    {#if guidance}<div class="attached">{guidance}</div>{/if}
  {:else if prompt.text}<pre class="prompt-text">{prompt.text}</pre>{/if}
  {#if images.length}
    <div class="shots">
      {#each images as u (u.uploadId)}<img src={uploadUrl(u.uploadId)} alt={u.name} loading="lazy" />{/each}
    </div>
  {/if}
  {#if files.length}<div class="attached">attached: {files.map((u) => u.name).join(", ")}</div>{/if}
  {#if prompt.state === "dropped"}<div class="resend"><button class="btn small" onclick={() => onResend(prompt.text)}>Resend</button></div>{/if}
</div>

{#if sheetOpen}
  <TextActions markdown={prompt.text} plain={prompt.text} {onQuote} {onFork} onClose={() => (sheetOpen = false)} />
{/if}
