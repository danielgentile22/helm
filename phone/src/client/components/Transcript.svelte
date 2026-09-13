<script lang="ts">
  import type { TurnId, UploadId } from "../../shared/protocol";
  import ActivityBlock from "../blocks/ActivityBlock.svelte";
  import EndLine from "../blocks/EndLine.svelte";
  import FileCard from "../blocks/FileCard.svelte";
  import PromptBlock from "../blocks/PromptBlock.svelte";
  import TextBlock from "../blocks/TextBlock.svelte";
  import ThinkingBlock from "../blocks/ThinkingBlock.svelte";
  import type { Block, Section } from "../transcript";

  let {
    sections,
    openTurn,
    replaying,
    onResend,
    onQuote,
    uploadUrl,
    fileUrl,
    fetchFile,
  }: {
    sections: readonly Section[];
    openTurn: TurnId | null;
    replaying: boolean;
    onResend: (text: string) => void;
    onQuote: (quoted: string) => void;
    uploadUrl: (uploadId: UploadId) => string;
    fileUrl: (fileId: string) => string;
    fetchFile: (fileId: string, onProgress: (bytes: number) => void) => Promise<Blob>;
  } = $props();

  const GLYPH: Readonly<Record<Block["kind"], string>> = { prompt: "❯", thinking: "∴", text: "·", activity: "$", end: "", file: "↓", note: "" };

  /**
   * A block animates only if the log was already on screen, and live, before the render that
   * created it: a replay appends a block at a time exactly as a live turn does, and can land
   * whole inside one render, so what separates them is one render's distance. Both variables
   * are plain rather than state, because the action reads them and a reactive read would
   * re-run every element's action and fly the whole log in at once.
   */
  let animates = false;
  let wasLive = false;
  $effect.pre(() => {
    void sections;
    animates = wasLive;
    wasLive = !replaying;
  });

  function enters(node: HTMLElement): void {
    if (animates) node.classList.add("enters");
  }

  /**
   * The code blocks arrive as injected HTML, so their copy buttons have no
   * handlers of their own; one listener on the root covers every one of them.
   */
  function onCopy(e: MouseEvent): void {
    const btn = (e.target as HTMLElement | null)?.closest("button[data-copy]");
    if (!(btn instanceof HTMLButtonElement)) return;
    const code = btn.closest(".code")?.querySelector("code");
    if (!code) return;
    const label = btn.textContent;
    navigator.clipboard.writeText(code.textContent ?? "").then(
      () => (btn.textContent = "Copied"),
      () => (btn.textContent = "Copy failed"),
    );
    setTimeout(() => (btn.textContent = label), 1000);
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="transcript" onclick={onCopy}>
  {#each sections as turn (turn.key)}
    {@const live = turn.turnId !== null && turn.turnId === openTurn}
    <section class="turn" class:is-live={live}>
      {#if live}<span class="rail" aria-hidden="true"><i></i></span>{/if}
      {#each turn.blocks as block (block.key)}
        <div class="blk blk-{block.kind}" data-glyph={GLYPH[block.kind]} use:enters>
          {#if block.kind === "prompt"}
            <PromptBlock line={block.prompt} {onResend} {uploadUrl} />
          {:else if block.kind === "thinking"}
            <ThinkingBlock text={block.text} collapsed={block.collapsed} streaming={block.streaming} />
          {:else if block.kind === "text"}
            <TextBlock text={block.text} streaming={block.streaming} {onQuote} />
          {:else if block.kind === "activity"}
            <ActivityBlock {block} />
          {:else if block.kind === "end"}
            <EndLine outcome={block.outcome} error={block.error} />
          {:else if block.kind === "file"}
            <FileCard line={block.file} url={fileUrl(block.file.fileId)} fetch={(onProgress) => fetchFile(block.file.fileId, onProgress)} />
          {:else}
            <div class="note">{block.text}</div>
          {/if}
        </div>
      {/each}
    </section>
  {/each}
</div>
