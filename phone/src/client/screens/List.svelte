<script lang="ts">
  import type { ThreadSummary } from "../../shared/protocol";
  import type { HelmClient } from "../api";
  import { fmtK, fmtTime, shortModel, shortPath } from "../format";
  import { router } from "../route.svelte";
  import NewThread from "../sheets/NewThread.svelte";

  let { api }: { api: HelmClient } = $props();

  let threads = $state<readonly ThreadSummary[]>([]);
  let loaded = $state(false);
  let loadError = $state("");
  let sheetOpen = $state(false);

  async function load(): Promise<void> {
    try {
      threads = await api.listThreads();
      loadError = "";
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
    }
    loaded = true;
  }

  $effect(() => {
    void load();
    let pending: ReturnType<typeof setTimeout> | null = null;
    const stop = api.attachGlobal(() => {
      if (pending) clearTimeout(pending);
      pending = setTimeout(() => void load(), 150);
    });
    const onVisible = (): void => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      if (pending) clearTimeout(pending);
      stop();
      document.removeEventListener("visibilitychange", onVisible);
    };
  });
</script>

<main class="screen">
  <header class="topbar">
    <h1>Helm</h1>
    <button class="icon-btn" aria-label="Settings" onclick={() => router.navigate("/settings")}>
      <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="8" cy="8" r="2.3" /><circle cx="8" cy="8" r="5.4" />
        <path d="M8 1.3v1.3M8 13.4v1.3M14.7 8h-1.3M2.6 8H1.3M12.74 3.26l-.92.92M4.18 11.82l-.92.92M12.74 12.74l-.92-.92M4.18 4.18l-.92-.92" />
      </svg>
    </button>
    <button class="btn primary small" onclick={() => (sheetOpen = true)}>New</button>
  </header>
  <ul class="list">
    {#if loadError}
      <li class="center error">Could not load threads: {loadError}</li>
    {:else if threads.length}
      {#each threads as t (t.config.threadId)}
        <li>
          <button class="card" onclick={() => router.navigate(`/t/${t.config.threadId}`)}>
            <div class="title">
              <span>{t.config.title ?? "Untitled"}</span>
              {#if t.session === "running" || t.session === "warming"}<span class="badge running">running</span>{/if}
            </div>
            {#if t.preview}<div class="preview">{t.preview}</div>{/if}
            <div class="meta">
              <span>{shortModel(t.config.model)}</span>
              {#if t.contextTokens !== null}<span>ctx {fmtK(t.contextTokens)}</span>{/if}
              <span>{fmtTime(t.lastTurnEndedAt ?? t.config.createdAt)}</span>
              <span>{shortPath(t.config.cwd)}</span>
            </div>
          </button>
        </li>
      {/each}
    {:else if loaded}
      <li class="center muted">No threads yet. Tap New.</li>
    {/if}
  </ul>
  {#if sheetOpen}
    <NewThread {api} onClose={() => (sheetOpen = false)} />
  {/if}
</main>
