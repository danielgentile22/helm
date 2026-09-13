<script lang="ts">
  import type { TurnId, UploadId } from "../../shared/protocol";
  import ActivityBlock from "../blocks/ActivityBlock.svelte";
  import EndLine from "../blocks/EndLine.svelte";
  import PromptBlock from "../blocks/PromptBlock.svelte";
  import TextBlock from "../blocks/TextBlock.svelte";
  import ThinkingBlock from "../blocks/ThinkingBlock.svelte";
  import type { Block } from "../transcript";

  let { blocks, openTurn, replaying, onResend, onQuote, uploadUrl }: { blocks: readonly Block[]; openTurn: TurnId | null; replaying: boolean; onResend: (text: string) => void; onQuote: (quoted: string) => void; uploadUrl: (uploadId: UploadId) => string } = $props();

  interface Turn {
    key: string;
    turnId: TurnId | null;
    blocks: { block: Block; key: string; glyph: string }[];
  }

  const GLYPH: Readonly<Record<Block["kind"], string>> = { prompt: "❯", thinking: "∴", text: "·", activity: "$", end: "", note: "" };

  function keyOf(block: Block, ix: number): string {
    switch (block.kind) {
      case "prompt":
        return block.line.clientMsgId;
      case "thinking":
        return `${block.turnId}:think:${ix}`;
      case "text":
        return `${block.turnId}:text:${block.blockIx}`;
      case "activity":
        return block.key;
      case "end":
        return `${block.turnId}:end`;
      case "note":
        return `note:${ix}`;
    }
  }

  /**
   * One section per turn, because the travelling rail light belongs to the
   * stretch of log the running turn owns. A prompt opens a section and the
   * first block carrying a turn id claims it; anything with an unclaimed
   * turn id opens a section of its own.
   */
  function toTurns(list: readonly Block[]): Turn[] {
    const turns: Turn[] = [];
    let cur: Turn | null = null;
    let adoptable = false;
    list.forEach((block, ix) => {
      const entry = { block, key: keyOf(block, ix), glyph: GLYPH[block.kind] };
      const turnId = block.kind === "prompt" || block.kind === "note" ? null : block.turnId;
      if (block.kind === "prompt") {
        cur = { key: `p:${block.line.clientMsgId}`, turnId: null, blocks: [entry] };
        adoptable = block.line.state === "started";
        turns.push(cur);
        return;
      }
      if (turnId !== null && cur !== null && cur.turnId === null && adoptable) cur.turnId = turnId;
      if (cur === null || (turnId !== null && turnId !== cur.turnId)) {
        cur = { key: turnId !== null ? `t:${turnId}` : `n:${ix}`, turnId, blocks: [entry] };
        adoptable = false;
        turns.push(cur);
        return;
      }
      cur.blocks.push(entry);
    });
    return turns;
  }

  const turns = $derived(toTurns(blocks));

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
    void blocks;
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
  {#each turns as turn (turn.key)}
    <section class="turn" class:is-live={turn.turnId !== null && turn.turnId === openTurn}>
      {#each turn.blocks as { block, key, glyph } (key)}
        <div class="blk blk-{block.kind}" data-glyph={glyph} use:enters>
          {#if block.kind === "prompt"}
            <PromptBlock line={block.line} {onResend} {uploadUrl} />
          {:else if block.kind === "thinking"}
            <ThinkingBlock text={block.text} collapsed={block.collapsed} streaming={block.streaming} />
          {:else if block.kind === "text"}
            <TextBlock text={block.text} streaming={block.streaming} {onQuote} />
          {:else if block.kind === "activity"}
            <ActivityBlock {block} />
          {:else if block.kind === "end"}
            <EndLine outcome={block.outcome} error={block.error} />
          {:else}
            <div class="note">{block.text}</div>
          {/if}
        </div>
      {/each}
    </section>
  {/each}
</div>
