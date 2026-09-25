<script lang="ts">
  /**
   * A vault note a save wrote or changed. One tap opens the markdown through
   * the same file route an offered file is served by. The folder is shown
   * above the note's own name, so a long Atlas path stays readable on a phone.
   */
  import type { RecordedItem } from "../../shared/turns";

  let { note, url }: { note: RecordedItem; url: string } = $props();

  const name = $derived(note.rel.split("/").at(-1) ?? note.rel);
  const folder = $derived(note.rel.slice(0, Math.max(0, note.rel.length - name.length - 1)));
</script>

<div class="note-card">
  <a class="file-main" href={url} target="_blank" rel="noopener" aria-label={`Vault note ${note.rel}. ${note.summary}. Tap to open.`}>
    <span class="badge" aria-hidden="true">NOTE</span>
    <span class="meta">
      <span class="name">{name}</span>
      {#if folder}<span class="sub">{folder}</span>{/if}
      <span class="note-line">{note.summary}</span>
    </span>
  </a>
</div>
