<script lang="ts">
  import { tick } from "svelte";
  import type { ThreadId } from "../../shared/protocol";
  import type { HelmClient } from "../api";
  import Composer from "../components/Composer.svelte";
  import Gauge from "../components/Gauge.svelte";
  import Menu from "../components/Menu.svelte";
  import StatusBar from "../components/StatusBar.svelte";
  import Transcript from "../components/Transcript.svelte";
  import { router } from "../route.svelte";
  import ArchiveConfirm from "../sheets/ArchiveConfirm.svelte";
  import ModelEffort from "../sheets/ModelEffort.svelte";
  import Rename from "../sheets/Rename.svelte";
  import ThreadInfo from "../sheets/ThreadInfo.svelte";
  import { ThreadSession } from "../thread.svelte";
  import { jumpCount, toBlocks } from "../transcript";
  import ErrorScreen from "./ErrorScreen.svelte";

  let { api, threadId }: { api: HelmClient; threadId: ThreadId } = $props();

  let session = $state<ThreadSession | null>(null);
  let failure = $state<unknown>(null);
  let menuOpen = $state(false);
  let openSheet = $state<"rename" | "model" | "info" | "archive" | null>(null);
  let insert = $state<(text: string) => void>(() => undefined);
  let atBottom = $state(true);
  /** Blocks the reader has already had under their eyes. Frozen while they are scrolled up. */
  let seenCount = $state(0);
  let deepLinked = false;

  const blocks = $derived(session ? toBlocks(session.view) : []);
  const unseen = $derived(jumpCount(blocks, seenCount));

  const nearBottom = (): boolean => document.documentElement.scrollHeight - window.scrollY - window.innerHeight < 80;
  const toBottom = (): void => window.scrollTo(0, document.body.scrollHeight);

  function follow(): void {
    atBottom = true;
    toBottom();
  }

  $effect(() => {
    let live: ThreadSession | null = null;
    let cancelled = false;
    seenCount = 0;
    deepLinked = false;
    atBottom = true;
    void (async () => {
      try {
        const summary = await api.getThread(threadId);
        live = new ThreadSession(api, threadId, summary);
        if (cancelled) live.stop();
        else session = live;
      } catch (err) {
        failure = err;
      }
    })();
    return () => {
      cancelled = true;
      live?.stop();
    };
  });

  $effect(() => {
    const onScroll = (): void => {
      atBottom = nearBottom();
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  });

  // Reads atBottom as well as the blocks, so resuming the follow catches the count up too.
  $effect(() => {
    const count = blocks.length;
    if (!atBottom) return;
    seenCount = count;
    void tick().then(toBottom);
  });

  // `/t/<id>#end` is where a push notification lands: hold at the newest block once the
  // first sync has told us the replay is complete.
  $effect(() => {
    if (deepLinked || !session || session.view.replaying) return;
    deepLinked = true;
    if (location.hash === "#end") void tick().then(follow);
  });

</script>

{#if failure}
  <ErrorScreen error={failure} />
{:else if session}
  {@const s = session}
  <main class="screen">
    <div class="head">
    <header class="topbar">
      <button class="icon-btn" aria-label="Back" onclick={() => router.navigate("/")}>‹</button>
      <h1>{s.summary.config.title ?? "Untitled"}</h1>
      <Gauge tokens={s.view.contextTokens} limit={s.summary.contextWindow} />
      <div class="anchor">
        <button class="icon-btn" aria-label="Thread menu" onclick={() => (menuOpen = true)}>⋯</button>
        {#if menuOpen}
          <Menu
            onClose={() => (menuOpen = false)}
            onRename={() => ((menuOpen = false), (openSheet = "rename"))}
            onModel={() => ((menuOpen = false), (openSheet = "model"))}
            onInfo={() => ((menuOpen = false), (openSheet = "info"))}
            onArchive={() => ((menuOpen = false), (openSheet = "archive"))}
          />
        {/if}
      </div>
    </header>
    <StatusBar conn={s.conn} seen={s.view.headSeq} head={s.summary.headSeq} />
    </div>
    <Transcript {blocks} openTurn={s.view.openTurn} replaying={s.view.replaying} onResend={(text) => void s.submit(text, [])} onQuote={(quoted) => insert(quoted)} uploadUrl={(uploadId) => api.uploadUrl(threadId, uploadId)} />
    {#if s.error}
      <div class="inline-error">
        <span class="glyph">▲</span>
        <span class="grow">{s.error}</span>
        <button class="icon-btn" aria-label="Dismiss" onclick={() => (s.error = null)}>✕</button>
      </div>
    {/if}
    <div class="dock">
      {#if unseen > 0}
        <button class="jump" onclick={follow}><span class="glyph">▾</span>{unseen} new</button>
      {/if}
      <Composer session={s} {api} onModel={() => (openSheet = "model")} bind:insert />
    </div>
    {#if openSheet === "rename"}
      <Rename {api} config={s.summary.config} onClose={() => (openSheet = null)} />
    {:else if openSheet === "model"}
      <ModelEffort {api} config={s.summary.config} onClose={() => (openSheet = null)} />
    {:else if openSheet === "info"}
      <ThreadInfo view={s.view} summary={s.summary} onClose={() => (openSheet = null)} />
    {:else if openSheet === "archive"}
      <ArchiveConfirm {api} {threadId} onClose={() => (openSheet = null)} />
    {/if}
  </main>
{:else}
  <main class="screen"><p class="muted center">Loading Helm</p></main>
{/if}
