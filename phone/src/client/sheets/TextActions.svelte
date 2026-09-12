<script lang="ts">
  let { markdown, plain, onQuote, onClose }: { markdown: string; plain: string; onQuote: (quoted: string) => void; onClose: () => void } = $props();

  let copied = $state("");
  let failed = $state(false);

  async function copy(what: "markdown" | "plain"): Promise<void> {
    try {
      await navigator.clipboard.writeText(what === "markdown" ? markdown : plain);
      copied = what;
      setTimeout(onClose, 600);
    } catch {
      failed = true;
    }
  }

  const quote = (): void => {
    onQuote(`${markdown.split("\n").map((l) => `> ${l}`).join("\n")}\n\n`);
    onClose();
  };
</script>

<div class="sheet" onclick={(e) => e.target === e.currentTarget && onClose()} role="presentation">
  <div class="panel">
    <div class="grab"></div>
    <button class="mitem" type="button" onclick={() => void copy("markdown")}>{copied === "markdown" ? "Copied" : "Copy markdown"}</button>
    <button class="mitem" type="button" onclick={() => void copy("plain")}>{copied === "plain" ? "Copied" : "Copy plain text"}</button>
    <button class="mitem" type="button" onclick={quote}>Quote into the composer</button>
    {#if failed}<p class="error">▲ The clipboard refused the copy</p>{/if}
    <div class="actions">
      <span class="grow"></span>
      <button class="btn" onclick={onClose}>Cancel</button>
    </div>
  </div>
</div>
