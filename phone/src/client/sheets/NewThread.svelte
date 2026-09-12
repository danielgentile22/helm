<script lang="ts">
  import { DEFAULT_EFFORT, type Effort, type ModelChoice } from "../../shared/protocol";
  import type { HelmClient } from "../api";
  import DirBrowser from "../components/DirBrowser.svelte";
  import { uuid } from "../format";
  import { models } from "../models";
  import { router } from "../route.svelte";

  let { api, onClose, initialCwd, initialModel, initialEffort }: { api: HelmClient; onClose: () => void; initialCwd?: string; initialModel?: string; initialEffort?: string } = $props();

  let ready = $state(false);
  let catalog = $state<readonly ModelChoice[]>([]);
  // The sheet is mounted fresh on each open, so the prefill is a starting value, not a binding.
  // svelte-ignore state_referenced_locally
  let cwd = $state(initialCwd ?? "");
  let model = $state("");
  let effort = $state<string>(DEFAULT_EFFORT);
  let err = $state("");

  const choice = $derived(catalog.find((c) => c.id === model));
  const efforts = $derived(choice?.efforts ?? []);
  const effortHidden = $derived(!choice?.supportsEffort);

  $effect(() => {
    void (async () => {
      catalog = await models(api).catch(() => [] as readonly ModelChoice[]);
      const preferred = catalog.find((m) => m.id === initialModel);
      model = (preferred ?? catalog.find((m) => /opus/i.test(m.id)) ?? catalog[0])?.id ?? "";
      ready = true;
    })();
  });

  $effect(() => {
    if (initialEffort && efforts.includes(initialEffort as Effort)) effort = initialEffort;
    else effort = efforts.includes(DEFAULT_EFFORT) ? DEFAULT_EFFORT : (efforts[0] ?? DEFAULT_EFFORT);
  });

  async function create(): Promise<void> {
    try {
      const cfg = await api.createThread({ threadId: uuid(), cwd, model: model as ModelChoice["id"], effort: (effort || DEFAULT_EFFORT) as Effort });
      onClose();
      router.navigate(`/t/${cfg.threadId}`);
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
  }
</script>

{#if ready}
  <div class="sheet" onclick={(e) => e.target === e.currentTarget && onClose()} role="presentation">
    <div class="panel">
      <h2>New thread</h2>
      <div class="field">
        <!-- svelte-ignore a11y_label_has_associated_control -->
        <label>Working directory (Claude reads its CLAUDE.md)</label>
        <DirBrowser {api} initial={initialCwd ?? ""} onPick={(p) => (cwd = p)} />
      </div>
      <div class="field">
        <label for="new-model">Model</label>
        {#if catalog.length}
          <select id="new-model" bind:value={model}>
            {#each catalog as m (m.id)}<option value={m.id}>{m.label}</option>{/each}
          </select>
        {:else}
          <span class="error">Model catalog unavailable</span>
        {/if}
      </div>
      <div class="field" hidden={effortHidden}>
        <label for="new-effort">Effort</label>
        <select id="new-effort" bind:value={effort}>
          {#each efforts as e (e)}<option value={e}>{e}</option>{/each}
        </select>
      </div>
      <p class="error">{err}</p>
      <div class="actions">
        <button class="btn" onclick={onClose}>Cancel</button>
        <span class="grow"></span>
        <button class="btn primary" disabled={!catalog.length} onclick={create}>Create</button>
      </div>
    </div>
  </div>
{/if}
