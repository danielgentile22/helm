<script lang="ts">
  import type { ThreadSummary } from "../../shared/protocol";
  import type { HelmClient } from "../api";
  import { fmtK, fmtTime, shortModel, shortPath } from "../format";
  import { enablePush, pushEnabled } from "../push";
  import { router } from "../route.svelte";
  import NewThread from "../sheets/NewThread.svelte";

  let { api }: { api: HelmClient } = $props();

  let threads = $state<readonly ThreadSummary[]>([]);
  let loaded = $state(false);
  let loadError = $state("");
  let notifyHidden = $state(false);
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

  async function notify(): Promise<void> {
    await enablePush(api);
    notifyHidden = await pushEnabled();
  }

  $effect(() => {
    void load();
    void pushEnabled().then((done) => (notifyHidden = done));
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
    <button class="btn small" hidden={notifyHidden} onclick={notify}>Notifications</button>
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
