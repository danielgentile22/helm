<script lang="ts">
  import { tick } from "svelte";
  import type { ThreadId } from "../../shared/protocol";
  import type { HelmClient } from "../api";
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
  import { toBlocks } from "../transcript";
  import ErrorScreen from "./ErrorScreen.svelte";

  let { api, threadId }: { api: HelmClient; threadId: ThreadId } = $props();

  let session = $state<ThreadSession | null>(null);
  let failure = $state<unknown>(null);
  let sheetOpen = $state(false);
  let menuOpen = $state(false);
  let openSheet = $state<"rename" | "info" | "archive" | null>(null);
  let uploading = $state(false);
  let inputEl: HTMLTextAreaElement | null = $state(null);
  let fileEl: HTMLInputElement | null = $state(null);
  let atBottom = $state(true);

  const nearBottom = (): boolean => document.documentElement.scrollHeight - window.scrollY - window.innerHeight < 80;

  $effect(() => {
    let live: ThreadSession | null = null;
    let cancelled = false;
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

  $effect(() => {
    void session?.view.lines;
    void tick().then(() => {
      if (atBottom) window.scrollTo(0, document.body.scrollHeight);
    });
  });

  function autogrow(): void {
    if (!inputEl) return;
    inputEl.style.height = "";
    inputEl.style.height = `${Math.min(inputEl.scrollHeight, window.innerHeight * 0.4)}px`;
  }

  async function send(): Promise<void> {
    if (!session || !inputEl) return;
    const text = inputEl.value.trim();
    if (!text && !session.attachments.length) return;
    const ids = session.attachments.map((a) => a.uploadId);
    inputEl.value = "";
    inputEl.style.height = "";
    session.attachments = [];
    await session.submit(text, ids);
  }

  async function pickFiles(): Promise<void> {
    if (!fileEl) return;
    const files = Array.from(fileEl.files ?? []);
    fileEl.value = "";
    if (!files.length || !session) return;
    uploading = true;
    await session.upload(files);
    uploading = false;
  }
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
            onInfo={() => ((menuOpen = false), (openSheet = "info"))}
            onArchive={() => ((menuOpen = false), (openSheet = "archive"))}
          />
        {/if}
      </div>
    </header>
    <StatusBar conn={s.conn} seen={s.view.headSeq} head={s.summary.headSeq} />
    </div>
    <Transcript blocks={toBlocks(s.view)} openTurn={s.view.openTurn} onResend={(text) => void s.submit(text, [])} />
    {#if s.error}
      <div class="inline-error">
        <span class="glyph">▲</span>
        <span class="grow">{s.error}</span>
        <button class="icon-btn" aria-label="Dismiss" onclick={() => (s.error = null)}>✕</button>
      </div>
    {/if}
    <div class="attachments">
      {#each s.attachments as a (a.uploadId)}<span>{a.name}</span>{/each}
    </div>
    <div class="composer">
      <button class="btn" disabled={uploading} onclick={() => fileEl?.click()}>+</button>
      <textarea
        bind:this={inputEl}
        placeholder="Message"
        rows="1"
        oninput={autogrow}
        onkeydown={(e) => (e.key === "Enter" && (e.metaKey || e.ctrlKey) ? void send() : undefined)}
      ></textarea>
      <button class="btn primary" onclick={() => void send()}>Send</button>
      <button class="btn" hidden={!s.running} onclick={() => s.interrupt()}>Stop</button>
    </div>
    <input type="file" multiple hidden bind:this={fileEl} onchange={pickFiles} />
    {#if sheetOpen}
      <ModelEffort {api} config={s.summary.config} onClose={() => (sheetOpen = false)} />
    {/if}
    {#if openSheet === "rename"}
      <Rename {api} config={s.summary.config} onClose={() => (openSheet = null)} />
    {:else if openSheet === "info"}
      <ThreadInfo view={s.view} summary={s.summary} onClose={() => (openSheet = null)} />
    {:else if openSheet === "archive"}
      <ArchiveConfirm {api} {threadId} onClose={() => (openSheet = null)} />
    {/if}
  </main>
{:else}
  <main class="screen"><p class="muted center">Loading Helm</p></main>
{/if}
