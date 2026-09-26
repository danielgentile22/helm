<script lang="ts" module>
  import type { RowState } from "../groups";

  const STATE_GLYPH: Record<RowState, string> = { waiting: "?", running: "◆", done: "✓", orphaned: "⊘", error: "▲", archived: "▢", idle: "○" };
</script>

<script lang="ts">
  import { tick } from "svelte";
  import { flip } from "svelte/animate";
  import type { ModelChoice, SearchHit, ThreadSummary } from "../../shared/protocol";
  import type { HelmClient } from "../api";
  import { fmtRelative, shortPath } from "../format";
  import { groupThreads, rowState } from "../groups";
  import { segments } from "../highlight";
  import { models } from "../models";
  import { motion } from "../motion";
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

  let query = $state("");
  const trimmed = $derived(query.trim());
  let results = $state<{ query: string; hits: readonly SearchHit[] } | null>(null);
  let searching = $state(false);
  let searchError = $state("");

  let pressTimer: ReturnType<typeof setTimeout> | null = null;
  let suppressClick = false;
  let savedScroll = 0;
  let wasSearching = false;
  let latestRequest = 0;
  let screen: HTMLElement | null = null;

  // On the two-pane layout the list scrolls inside .pane-list, not the window.
  const scroller = (): HTMLElement | null => screen?.closest(".pane-list") ?? null;
  const scrollTop = (): number => scroller()?.scrollTop ?? window.scrollY;
  const scrollToTop = (y: number): void => {
    const pane = scroller();
    if (pane) pane.scrollTop = y;
    else window.scrollTo(0, y);
  };

  const groups = $derived(groupThreads(threads, showArchived));

  function splitPath(cwd: string): { head: string; tail: string } {
    const p = shortPath(cwd);
    const cut = p.lastIndexOf("/");
    return cut < 0 ? { head: "", tail: p } : { head: p.slice(0, cut + 1), tail: p.slice(cut + 1) };
  }

  async function load(): Promise<void> {
    try {
      threads = await api.listThreads(showArchived);
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
    void showArchived;
    void load();
  });

  $effect(() => {
    const sent = trimmed;
    if (sent && !wasSearching) savedScroll = scrollTop();
    if (!sent && wasSearching) void tick().then(() => scrollToTop(savedScroll));
    wasSearching = sent !== "";

    searchError = "";
    if (!sent) {
      latestRequest++;
      results = null;
      searching = false;
      return;
    }
    searching = true;
    const thisRequest = ++latestRequest;
    const timer = setTimeout(() => {
      void api.searchThreads(sent, true, 50).then(
        (hits) => {
          if (thisRequest !== latestRequest) return;
          results = { query: sent, hits };
          searching = false;
        },
        (err: unknown) => {
          if (thisRequest !== latestRequest) return;
          searchError = `Could not search: ${err instanceof Error ? err.message : String(err)}`;
          searching = false;
        },
      );
    }, 200);
    return () => clearTimeout(timer);
  });

  $effect(() => {
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

<main class="screen" bind:this={screen}>
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

  <div class="searchbar">
    <input class="search" type="search" bind:value={query} aria-label="Search threads" placeholder="Search" enterkeyhint="search" autocomplete="off" />
  </div>

  {#if loadError}<p class="center error">▲ {loadError}</p>{/if}
  {#if createError}<p class="center error">▲ {createError}</p>{/if}
  {#if searchError}<p class="center error">▲ {searchError}</p>{/if}

  <div aria-live="polite">
    {#if trimmed && searching}<p class="center muted">Searching…</p>{/if}
    {#if trimmed && results && results.query === trimmed && results.hits.length === 0}
      <p class="center muted">No matches for “{results.query}”</p>
    {/if}
  </div>

  <div class="groups">
    {#if trimmed}
      {#if results}
        <div class="rows">
          {#each results.hits as hit (hit.summary.config.threadId)}
            {@const st = rowState(hit.summary)}
            <button
              class="row"
              type="button"
              class:is-running={st === "running"}
              class:is-waiting={st === "waiting"}
              class:is-archived={st === "archived"}
              class:is-open={router.route.name === "thread" && router.route.threadId === hit.summary.config.threadId}
              onclick={() => router.navigate(hit.seq !== null ? `/t/${hit.summary.config.threadId}#seq=${hit.seq}` : `/t/${hit.summary.config.threadId}`)}
            >
              {#if st === "running"}<span class="rail" aria-hidden="true"><i></i></span>{/if}
              {#if st === "waiting"}<span class="waitbar" aria-hidden="true"></span>{/if}
              <span class="r1">
                <span class="title">{hit.summary.config.title ?? "Untitled"}</span>
                <span class="when">{fmtRelative(hit.summary.lastTurnEndedAt ?? hit.summary.config.createdAt, new Date())}</span>
              </span>
              <span class="r2">
                <span class="state {st}"><span class="glyph" aria-hidden="true">{STATE_GLYPH[st]}</span>{st}</span>
                {#if hit.summary.recorded}<span class="recorded"><span class="glyph" aria-hidden="true">▣</span>recorded</span>{/if}
              </span>
              {#if hit.snippet}
                <span class="snip">{#each segments(hit.snippet, hit.ranges) as seg}{#if seg.hit}<mark>{seg.text}</mark>{:else}{seg.text}{/if}{/each}</span>
              {/if}
            </button>
          {/each}
        </div>
      {/if}
    {:else if groups.length}
      {#each groups as g (g.cwd)}
        {@const path = splitPath(g.cwd)}
        <section class="group">
          <div class="ghead">
            {#if g.waiting > 0}
              <span class="live wait"><span class="glyph">?</span>{g.waiting} waiting</span>
            {/if}
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
                class:is-waiting={r.state === "waiting"}
                class:is-archived={r.state === "archived"}
                class:is-open={router.route.name === "thread" && router.route.threadId === r.summary.config.threadId}
                animate:flip={{ duration: motion.base }}
                onclick={() => router.navigate(`/t/${r.summary.config.threadId}`)}
              >
                {#if r.state === "running"}<span class="rail" aria-hidden="true"><i></i></span>{/if}
                {#if r.state === "waiting"}<span class="waitbar" aria-hidden="true"></span>{/if}
                <span class="r1">
                  <span class="title">{r.summary.config.title ?? "Untitled"}</span>
                  <span class="when">{fmtRelative(r.when, new Date())}</span>
                </span>
                <span class="r2">
                  <span class="state {r.state}"><span class="glyph" aria-hidden="true">{STATE_GLYPH[r.state]}</span>{r.state}</span>
                  {#if r.summary.recorded}<span class="recorded"><span class="glyph" aria-hidden="true">▣</span>recorded</span>{/if}
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
