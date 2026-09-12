<script lang="ts">
  import { DEFAULT_EFFORT, type DirEntry, type Effort, type ModelChoice } from "../../shared/protocol";
  import type { HelmClient } from "../api";
  import { shortPath, uuid } from "../format";
  import { models } from "../models";
  import { router } from "../route.svelte";

  let { api, onClose }: { api: HelmClient; onClose: () => void } = $props();

  let ready = $state(false);
  let roots: readonly DirEntry[] = [];
  let catalog = $state<readonly ModelChoice[]>([]);
  let cwd = $state("/");
  let parent = $state<string | null>(null);
  let entries = $state<readonly DirEntry[]>([]);
  let model = $state("");
  let effort = $state<string>(DEFAULT_EFFORT);
  let err = $state("");

  const choice = $derived(catalog.find((c) => c.id === model));
  const efforts = $derived(choice?.efforts ?? []);
  const effortHidden = $derived(!choice?.supportsEffort);

  const parentOf = (p: string): string => p.replace(/\/[^/]+$/, "") || "/";

  async function browse(path: string, from: string | null): Promise<void> {
    cwd = path;
    parent = from;
    try {
      entries = from === null && path === "" ? roots : await api.browseDirs(path);
    } catch (e) {
      entries = [];
      err = e instanceof Error ? e.message : String(e);
    }
  }

  $effect(() => {
    void (async () => {
      roots = await api.browseDirs();
      catalog = await models(api).catch(() => [] as readonly ModelChoice[]);
      model = (catalog.find((m) => /opus/i.test(m.id)) ?? catalog[0])?.id ?? "";
      const start = roots.find((r) => /Vault$/.test(r.path))?.path ?? roots[0]?.path ?? "/";
      await browse(start, roots.some((r) => r.path === start) ? "" : parentOf(start));
      ready = true;
    })();
  });

  $effect(() => {
    effort = efforts.includes(DEFAULT_EFFORT) ? DEFAULT_EFFORT : (efforts[0] ?? DEFAULT_EFFORT);
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
        <div class="crumb">{shortPath(cwd)}</div>
        <div class="dirs">
          {#if parent !== null}
            <button onclick={() => void browse(parent!, roots.some((r) => r.path === parent) ? "" : parentOf(parent!))}>..</button>
          {/if}
          {#each entries as d (d.path)}
            <button onclick={() => void browse(d.path, cwd)}>{d.name}<span class="flags">{[d.hasClaudeMd ? "CLAUDE.md" : "", d.isGitRepo ? "git" : ""].filter(Boolean).join(" ")}</span></button>
          {/each}
        </div>
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
      <div class="row">
        <button class="btn" onclick={onClose}>Cancel</button>
        <span class="grow"></span>
        <button class="btn primary" disabled={!catalog.length} onclick={create}>Create</button>
      </div>
    </div>
  </div>
{/if}
