<script lang="ts">
  import type { ThreadId } from "../../shared/protocol";
  import type { HelmClient } from "../api";
  import { router } from "../route.svelte";

  let { api, threadId, onClose }: { api: HelmClient; threadId: ThreadId; onClose: () => void } = $props();

  let err = $state("");

  async function archive(): Promise<void> {
    try {
      await api.archiveThread(threadId);
      onClose();
      router.navigate("/");
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
  }
</script>

<div class="sheet" onclick={(e) => e.target === e.currentTarget && onClose()} role="presentation">
  <div class="panel">
    <div class="grab"></div>
    <h2>Archive this thread?</h2>
    <p class="muted">Its process stops and it leaves the list. The history is kept.</p>
    {#if err}<p class="error">{err}</p>{/if}
    <div class="actions">
      <button class="btn" onclick={onClose}>Cancel</button>
      <span class="grow"></span>
      <button class="btn danger" onclick={archive}><span class="glyph">▲</span>Archive</button>
    </div>
  </div>
</div>
