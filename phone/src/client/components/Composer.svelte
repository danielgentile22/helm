<script lang="ts">
  import type { ModelChoice } from "../../shared/protocol";
  import type { HelmClient } from "../api";
  import { emptyDraft, sentText, type Draft } from "../commands";
  import { models } from "../models";
  import type { ThreadSession } from "../thread.svelte";

  let {
    session,
    api,
    onModel,
    insert = $bindable(),
  }: {
    session: ThreadSession;
    api: HelmClient;
    onModel: () => void;
    insert: (text: string) => void;
  } = $props();

  let draft = $state<Draft>(emptyDraft());
  let inputEl: HTMLTextAreaElement | null = $state(null);
  let catalog = $state<readonly ModelChoice[]>([]);
  let uploading = $state(false);
  let fileEl: HTMLInputElement | null = $state(null);

  const config = $derived(session.summary.config);
  const choice = $derived(catalog.find((c) => c.id === config.model));
  const modelLabel = $derived(choice?.label ?? config.model);
  const hasContent = $derived(draft.text.trim() !== "" || draft.command !== null || session.attachments.length > 0);
  const stopping = $derived(session.running && !hasContent);

  /** State word plus its own glyph, so the composer never reports state by colour alone. */
  const PHASE: Readonly<Record<string, { word: string; glyph: string }>> = {
    offline: { word: "offline", glyph: "▲" },
    replaying: { word: "replaying", glyph: "↻" },
    running: { word: "running", glyph: "◆" },
    idle: { word: "idle", glyph: "◌" },
  };
  const phaseKey = $derived(session.conn === "offline" ? "offline" : session.conn === "connecting" || session.conn === "replaying" ? "replaying" : session.running ? "running" : "idle");
  const phase = $derived(PHASE[phaseKey]!);

  const keysShown = typeof matchMedia === "function" && matchMedia("(pointer: fine)").matches;

  $effect(() => {
    void models(api).then((list) => (catalog = list), () => undefined);
  });

  function autogrow(): void {
    if (!inputEl) return;
    inputEl.style.height = "";
    inputEl.style.height = `${Math.min(inputEl.scrollHeight, window.innerHeight * 0.4)}px`;
  }

  insert = (text: string): void => {
    if (!inputEl) return;
    const start = inputEl.selectionStart ?? draft.text.length;
    const end = inputEl.selectionEnd ?? start;
    draft.text = draft.text.slice(0, start) + text + draft.text.slice(end);
    const caret = start + text.length;
    inputEl.focus();
    inputEl.setSelectionRange(caret, caret);
    autogrow();
  };

  async function send(): Promise<void> {
    if (!hasContent) return;
    const text = sentText(draft);
    const uploads = session.attachments;
    draft = emptyDraft();
    session.attachments = [];
    if (inputEl) inputEl.style.height = "";
    await session.submit(text, uploads);
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void send();
    }
  }

  async function pickFiles(): Promise<void> {
    if (!fileEl) return;
    const files = Array.from(fileEl.files ?? []);
    fileEl.value = "";
    if (!files.length) return;
    uploading = true;
    await session.upload(files);
    uploading = false;
  }
</script>

<div class="composer">
  <div class="quick">
    {#if session.running}
      <button class="chip stop" type="button" onclick={() => session.interrupt()}><span class="glyph">■</span>Stop</button>
    {/if}
    <button class="chip" type="button" onclick={onModel}><b>{modelLabel}</b><span class="chev">▾</span></button>
    {#if choice?.supportsEffort}
      <button class="chip" type="button" onclick={onModel}><b>{config.effort}</b><span class="chev">▾</span></button>
    {/if}
  </div>
  {#if session.attachments.length}
    <div class="stage">
      {#each session.attachments as a (a.uploadId)}
        {#if a.mime.startsWith("image/")}
          <span class="th">
            <img src={api.uploadUrl(config.threadId, a.uploadId)} alt={a.name} />
            <button class="x" type="button" aria-label="Remove {a.name}" onclick={() => (session.attachments = session.attachments.filter((o) => o.uploadId !== a.uploadId))}>✕</button>
          </span>
        {:else}
          <span class="chip file">
            {a.name}
            <button class="x" type="button" aria-label="Remove {a.name}" onclick={() => (session.attachments = session.attachments.filter((o) => o.uploadId !== a.uploadId))}>✕</button>
          </span>
        {/if}
      {/each}
    </div>
  {/if}
  <div class="inputrow">
    <button class="attach" type="button" aria-label="Attach a file" disabled={uploading} onclick={() => fileEl?.click()}>+</button>
    <textarea bind:this={inputEl} bind:value={draft.text} class="box" placeholder="Message" rows="1" oninput={autogrow} onkeydown={onKeydown}></textarea>
    <button class="send" class:stop={stopping} type="button" aria-label={stopping ? "Stop" : "Send"} onclick={() => (stopping ? session.interrupt() : void send())}>{stopping ? "■" : "↑"}</button>
  </div>
  <div class="helper">
    <span class="glyph">{phase.glyph}</span>{phase.word}{#if keysShown}<span class="keys">⌘↩ sends</span>{/if}
  </div>
  <input type="file" multiple hidden bind:this={fileEl} onchange={pickFiles} />
</div>
