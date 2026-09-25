<script lang="ts">
  import type { ThreadConfig } from "../../shared/protocol";
  import type { HelmClient } from "../api";
  import Sheet from "../components/Sheet.svelte";

  let { api, config, onClose }: { api: HelmClient; config: ThreadConfig; onClose: () => void } = $props();

  // svelte-ignore state_referenced_locally
  let title = $state(config.title ?? "");
  let err = $state("");

  async function save(): Promise<void> {
    if (!title.trim()) return;
    try {
      await api.patchThread(config.threadId, { title: title.trim() });
      onClose();
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
  }
</script>

<Sheet {onClose}>
  <div class="grab"></div>
  <h2>Rename thread</h2>
  <div class="field">
    <label for="rename-title">Title</label>
    <!-- svelte-ignore a11y_autofocus -->
    <input id="rename-title" autofocus bind:value={title} onkeydown={(e) => e.key === "Enter" && void save()} />
  </div>
  {#if err}<p class="error">{err}</p>{/if}
  <div class="actions">
    <button class="btn" onclick={onClose}>Cancel</button>
    <span class="grow"></span>
    <button class="btn primary" disabled={!title.trim()} onclick={save}>Save</button>
  </div>
</Sheet>
