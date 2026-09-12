<script lang="ts">
  import { untrack } from "svelte";
  import type { Effort, ModelChoice, ThreadConfig } from "../../shared/protocol";
  import type { HelmClient } from "../api";
  import { models } from "../models";

  let { api, config, onClose }: { api: HelmClient; config: ThreadConfig; onClose: () => void } = $props();

  let catalog = $state<readonly ModelChoice[]>([]);
  let model = $state<string>(untrack(() => config.model));
  let effort = $state<string>(untrack(() => config.effort));

  const choice = $derived(catalog.find((c) => c.id === model) ?? catalog.find((c) => c.id === config.model));
  const efforts = $derived(choice?.efforts ?? []);
  const effortHidden = $derived(!choice?.supportsEffort);

  $effect(() => {
    void (async () => {
      const list = await models(api).catch(() => [] as readonly ModelChoice[]);
      if (!list.length) {
        onClose();
        return;
      }
      catalog = list;
    })();
  });

  // Tracks the effort list only. Reading config.effort here would reset the user's pick every
  // time an incoming thread.config event replaces the summary, a rename included.
  $effect(() => {
    const list = efforts;
    effort = untrack(() => (list.includes(config.effort) ? config.effort : (list[0] ?? config.effort)));
  });

  async function apply(): Promise<void> {
    const patch: { model?: ModelChoice["id"]; effort?: Effort } = {};
    if (model !== config.model) patch.model = model as ModelChoice["id"];
    if (!effortHidden && effort !== config.effort) patch.effort = effort as Effort;
    if (Object.keys(patch).length) await api.patchThread(config.threadId, patch);
    onClose();
  }
</script>

{#if catalog.length}
  <div class="sheet" onclick={(e) => e.target === e.currentTarget && onClose()} role="presentation">
    <div class="panel">
      <h2>Model and effort</h2>
      <p class="muted">Applies at the next turn.</p>
      <div class="field">
        <label for="cfg-model">Model</label>
        <select id="cfg-model" bind:value={model}>
          {#each catalog as m (m.id)}<option value={m.id}>{m.label}</option>{/each}
        </select>
      </div>
      <div class="field" hidden={effortHidden}>
        <label for="cfg-effort">Effort</label>
        <select id="cfg-effort" bind:value={effort}>
          {#each efforts as e (e)}<option value={e}>{e}</option>{/each}
        </select>
      </div>
      <div class="row">
        <button class="btn" onclick={onClose}>Cancel</button>
        <span class="grow"></span>
        <button class="btn primary" onclick={apply}>Apply</button>
      </div>
    </div>
  </div>
{/if}
