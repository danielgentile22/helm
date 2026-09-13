<script lang="ts">
  import type { ModelChoice, SlashCommand } from "../../shared/protocol";
  import type { HelmClient } from "../api";
  import { commandLabel, emptyDraft, filterCommands, sentText, slashToken, type Draft } from "../commands";
  import { models } from "../models";
  import Skills from "../sheets/Skills.svelte";
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
  let cameraEl: HTMLInputElement | null = $state(null);
  let sourcesOpen = $state(false);
  let skillsOpen = $state(false);

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

  const token = $derived(slashToken(draft));
  /** Eight rows is what fits above the keyboard; the Skills sheet is where the whole list lives. */
  const matches = $derived(token === null ? [] : filterCommands(session.commands, token).slice(0, 8));
  /** Escape holds the popover shut for the token it was shut on; typing on reopens it. */
  let dismissed = $state<string | null>(null);
  const popOpen = $derived(token !== null && token !== dismissed && matches.length > 0);
  let selected = $state(0);

  const placeholder = $derived(draft.command ? draft.command.argumentHint || "Message" : "Message");

  function pick(command: SlashCommand): void {
    draft = { command, text: "" };
    dismissed = null;
    selected = 0;
    inputEl?.focus();
  }

  function clearCommand(): void {
    draft.command = null;
    inputEl?.focus();
  }

  $effect(() => {
    void models(api).then((list) => (catalog = list), () => undefined);
  });

  function onInput(): void {
    selected = 0;
    autogrow();
  }

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
      return;
    }
    if (popOpen) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        selected = (selected + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length;
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pick(matches[selected] ?? matches[0]!);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        dismissed = token;
        return;
      }
    }
    if (e.key === "Backspace" && draft.command !== null && draft.text === "") {
      e.preventDefault();
      clearCommand();
    }
  }

  async function stage(files: readonly File[]): Promise<void> {
    if (!files.length) return;
    uploading = true;
    await session.upload(files);
    uploading = false;
  }

  async function pickFrom(el: HTMLInputElement | null): Promise<void> {
    if (!el) return;
    const files = Array.from(el.files ?? []);
    el.value = "";
    await stage(files);
  }

  /** Images on the clipboard become attachments; anything else pastes as text. */
  function onPaste(e: ClipboardEvent): void {
    const images = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
    if (!images.length) return;
    e.preventDefault();
    void stage(images);
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
    <button class="chip" type="button" onclick={() => (skillsOpen = true)}><span class="glyph">⌕</span>Skills</button>
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
  <div class="popanchor">
    {#if popOpen}
      <div class="pop">
        <div class="ph">commands matching “{token}”</div>
        {#each matches as c, ix (c.name)}
          <button class="cmd-row" class:sel={ix === selected} type="button" onmousedown={(e) => e.preventDefault()} onclick={() => pick(c)}>
            <span class="nm">{commandLabel(c)}</span>
            <span class="ds">{c.description}</span>
            <span class="ah">{c.argumentHint}</span>
          </button>
        {/each}
      </div>
    {/if}
    <div class="inputrow">
      <div class="anchor">
        <button class="attach" type="button" aria-label="Attach a file" disabled={uploading} onclick={() => (sourcesOpen = true)}>+</button>
        {#if sourcesOpen}
          <div class="menuscrim" onclick={() => (sourcesOpen = false)} role="presentation"></div>
          <div class="menu up">
            <button class="mitem" type="button" onclick={() => ((sourcesOpen = false), fileEl?.click())}>Photos and files</button>
            <button class="mitem" type="button" onclick={() => ((sourcesOpen = false), cameraEl?.click())}>Take photo</button>
          </div>
        {/if}
      </div>
      <div class="box">
        {#if draft.command}
          <span class="chip cmd">
            <b>{commandLabel(draft.command)}</b>
            <button class="x" type="button" aria-label="Remove the command" onclick={clearCommand}>✕</button>
          </span>
        {/if}
        <textarea bind:this={inputEl} bind:value={draft.text} class="ta" {placeholder} rows="1" oninput={onInput} onkeydown={onKeydown} onpaste={onPaste}></textarea>
      </div>
      <button class="send" class:stop={stopping} type="button" aria-label={stopping ? "Stop" : "Send"} onclick={() => (stopping ? session.interrupt() : void send())}>{stopping ? "■" : "↑"}</button>
    </div>
  </div>
  <div class="helper">
    <span class="glyph">{phase.glyph}</span>{phase.word}{#if keysShown}<span class="keys">⌘↩ sends</span>{/if}
  </div>
  <input type="file" multiple hidden bind:this={fileEl} onchange={() => void pickFrom(fileEl)} />
  <input type="file" accept="image/*" capture="environment" hidden bind:this={cameraEl} onchange={() => void pickFrom(cameraEl)} />
</div>
{#if skillsOpen}
  <Skills {session} onPick={(c) => ((skillsOpen = false), pick(c))} onClose={() => (skillsOpen = false)} />
{/if}
