<script lang="ts">
  import type { ThreadId } from "../../shared/protocol";
  import type { HelmClient } from "../api";
  import Sheet from "../components/Sheet.svelte";

  let { api, threadId, onClose }: { api: HelmClient; threadId: ThreadId; onClose: () => void } = $props();

  let guidance = $state("");
  let err = $state("");
  let saving = $state(false);

  async function save(): Promise<void> {
    saving = true;
    try {
      await api.saveToVault(threadId, guidance.trim() || null);
      onClose();
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
      saving = false;
    }
  }
</script>

<Sheet {onClose}>
  <div class="grab"></div>
  <h2>Save to vault</h2>
  <p class="muted">Claude records this thread's decisions and facts as Atlas notes, then shows them here as cards.</p>
  <div class="field">
    <label for="save-guidance">Guidance (optional)</label>
    <!-- svelte-ignore a11y_autofocus -->
    <input id="save-guidance" autofocus placeholder="focus on the backup decision" bind:value={guidance} onkeydown={(e) => e.key === "Enter" && !saving && void save()} />
  </div>
  {#if err}<p class="error">{err}</p>{/if}
  <div class="actions">
    <button class="btn" onclick={onClose}>Cancel</button>
    <span class="grow"></span>
    <button class="btn primary" disabled={saving} onclick={save}>Save</button>
  </div>
</Sheet>
