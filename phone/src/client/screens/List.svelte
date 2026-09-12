<script lang="ts" module>
  import type { RowState } from "../groups";

  const STATE_GLYPH: Record<RowState, string> = { running: "◆", done: "✓", orphaned: "⊘", error: "▲", archived: "▢", idle: "○" };
</script>

<script lang="ts">
  import { flip } from "svelte/animate";
  import type { ModelChoice, ThreadSummary } from "../../shared/protocol";
  import type { HelmClient } from "../api";
  import { fmtRelative, shortPath } from "../format";
  import { groupThreads } from "../groups";
  import { models } from "../models";
  import { createWithDefaults } from "../newThread";
  import { router } from "../route.svelte";
  import { settings } from "../settings.svelte";
  import NewThread from "../sheets/NewThread.svelte";

  const LONG_PRESS_MS = 500;

  let { api }: { api: HelmClient } = $props();

  let threads = $state<readonly ThreadSummary[]>([]);
  let catalog = $state<readonly ModelChoice[]>([]);
  let loaded = $state(false);
  let loadError = $state("");
  let createError = $state("");
  let sheetOpen = $state(false);
  let showArchived = $state(false);

  let pressTimer: ReturnType<typeof setTimeout> | null = null;
  let suppressClick = false;

  const groups = $derived(groupThreads(threads, showArchived));

  const flipMs = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--d-base")) || 200;

  function splitPath(cwd: string): { head: string; tail: string } {
    const p = shortPath(cwd);
    const cut = p.lastIndexOf("/");
    return cut < 0 ? { head: "", tail: p } : { head: p.slice(0, cut + 1), tail: p.slice(cut + 1) };
  }

  async function load(): Promise<void> {
    try {
      threads = await api.listThreads();
      loadError = "";
    } catch (err) {
      loadError = `Could not load threads: ${err instanceof Error ? err.message : String(err)}`;
    }
    loaded = true;
  }

  async function create(cwd?: string): Promise<void> {
    try {
      const cfg = await createWithDefaults(api, settings.value, catalog, cwd);
      createError = "";
      router.navigate(`/t/${cfg.threadId}`);
    } catch (err) {
      createError = `Could not create a thread: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  function pressStart(): void {
    suppressClick = false;
    pressTimer = setTimeout(() => {
      pressTimer = null;
      suppressClick = true;
      sheetOpen = true;
    }, LONG_PRESS_MS);
  }

  function pressCancel(): void {
    if (pressTimer) clearTimeout(pressTimer);
    pressTimer = null;
  }

  function mainClick(): void {
    pressCancel();
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    void create();
  }

  $effect(() => {
    void load();
    void models(api).then((m) => (catalog = m), () => undefined);
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
      pressCancel();
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
    <span class="split">
      <button class="main" aria-label="New thread" onpointerdown={pressStart} onpointerup={pressCancel} onpointerleave={pressCancel} onclick={mainClick}>New</button>
      <button class="more" aria-label="More new thread options" onclick={() => (sheetOpen = true)}>▾</button>
    </span>
  </header>

  {#if loadError}<p class="center error">▲ {loadError}</p>{/if}
  {#if createError}<p class="center error">▲ {createError}</p>{/if}

  <div class="groups">
    {#if groups.length}
      {#each groups as g (g.cwd)}
        {@const path = splitPath(g.cwd)}
        <section class="group">
          <div class="ghead">
            {#if g.running > 0}
              <span class="live"><span class="dot pulse"></span>{g.running} running</span>
            {/if}
            <span class="path">{path.head}<b>{path.tail}</b></span>
            <button class="icon-btn plus" aria-label="New thread here" onclick={() => void create(g.cwd)}>+</button>
          </div>
          <div class="rows">
            {#each g.rows as r (r.summary.config.threadId)}
              {@const doing = r.state === "running" ? r.summary.doing : null}
              <button
                class="row"
                type="button"
                class:is-running={r.state === "running"}
                class:is-archived={r.state === "archived"}
                animate:flip={{ duration: flipMs }}
                onclick={() => router.navigate(`/t/${r.summary.config.threadId}`)}
              >
                <span class="r1">
                  <span class="title">{r.summary.config.title ?? "Untitled"}</span>
                  <span class="when">{fmtRelative(r.when, new Date())}</span>
                </span>
                <span class="r2">
                  <span class="state {r.state}"><span class="glyph" aria-hidden="true">{STATE_GLYPH[r.state]}</span>{r.state}</span>
                  {#if doing}
                    {#if doing.kind === "tool"}
                      <span class="doing">{doing.name} <em>{doing.arg}</em></span>
                    {:else}
                      <span class="doing">{doing.tail}</span>
                    {/if}
                  {:else}
                    <span class="preview">{r.summary.preview ?? ""}</span>
                  {/if}
                </span>
              </button>
            {/each}
          </div>
        </section>
      {/each}
    {:else if loaded && !loadError}
      <p class="center muted">No threads yet. Tap New.</p>
    {/if}
  </div>

  <div class="filterbar">
    <button class="chip" aria-pressed={showArchived} onclick={() => (showArchived = !showArchived)}>
      Archived <b>{showArchived ? "on" : "off"}</b>
    </button>
  </div>

  {#if sheetOpen}
    <NewThread {api} initialCwd={settings.value?.defaultCwd} initialModel={settings.value?.defaultModel ?? undefined} initialEffort={settings.value?.defaultEffort} onClose={() => (sheetOpen = false)} />
  {/if}
</main>
