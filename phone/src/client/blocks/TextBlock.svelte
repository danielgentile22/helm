<script lang="ts">
  import { renderMarkdown } from "../markdown";

  let { text, streaming }: { text: string; streaming: boolean } = $props();

  const html = $derived(renderMarkdown(text));
</script>

<div class="md" class:is-streaming={streaming}>{@html html}</div>
