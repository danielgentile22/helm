<script lang="ts">
  import { tick } from "svelte";
  import type { ThreadId } from "../../shared/protocol";
  import type { HelmClient } from "../api";
  import Transcript from "../components/Transcript.svelte";
  import { fmtK, shortModel } from "../format";
  import { router } from "../route.svelte";
  import ModelEffort from "../sheets/ModelEffort.svelte";
  import { ThreadSession } from "../thread.svelte";
  import { toBlocks } from "../transcript";
  import ErrorScreen from "./ErrorScreen.svelte";

  let { api, threadId }: { api: HelmClient; threadId: ThreadId } = $props();

  let session = $state<ThreadSession | null>(null);
  let failure = $state<unknown>(null);
  let sheetOpen = $state(false);
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
    <header class="topbar">
      <button class="btn small" onclick={() => router.navigate("/")}>‹</button>
      <div style="flex:1;min-width:0">
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
        <h1 onclick={() => void s.rename()}>{s.summary.config.title ?? "Untitled"}</h1>
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <div class="sub" onclick={() => (sheetOpen = true)}>
          {shortModel(s.summary.config.model)} · {s.summary.config.effort}{s.view.contextTokens !== null ? ` · ctx ${fmtK(s.view.contextTokens)}` : ""}
        </div>
      </div>
      <span class="conn {s.conn}">{s.connLabel}</span>
      <button class="btn small" onclick={() => void s.archive()}>Archive</button>
    </header>
    <Transcript blocks={toBlocks(s.view)} openTurn={s.view.openTurn} onResend={(text) => void s.submit(text, [])} />
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
  </main>
{:else}
  <main class="screen"><p class="muted center">Loading Helm</p></main>
{/if}
