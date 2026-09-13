<script lang="ts">
  import type { SlashCommand } from "../../shared/protocol";
  import { commandLabel, filterCommands } from "../commands";
  import type { ThreadSession } from "../thread.svelte";

  let { session, onPick, onClose }: { session: ThreadSession; onPick: (command: SlashCommand) => void; onClose: () => void } = $props();

  let query = $state("");
  let reloading = $state(false);

  const shown = $derived(filterCommands(session.commands, query.replace(/^\//, "").trim()));

  async function reload(): Promise<void> {
    reloading = true;
    await session.loadCommands(true);
    reloading = false;
  }
</script>

<svelte:window onkeydown={(e) => e.key === "Escape" && onClose()} />

<div class="sheet" onclick={(e) => e.target === e.currentTarget && onClose()} role="presentation">
  <div class="panel">
    <div class="grab"></div>
    <div class="shead">
      <h2>Skills</h2>
      <button class="chip" type="button" disabled={reloading} onclick={reload}>
        {#if reloading}<span class="spin"></span>{:else}<span class="glyph">↻</span>{/if}Reload
      </button>
      <button class="icon-btn" type="button" aria-label="Close" onclick={onClose}>✕</button>
    </div>
    <!-- svelte-ignore a11y_autofocus -->
    <input class="search" autofocus bind:value={query} aria-label="Search commands" placeholder="Search {session.commands.length} commands" />
    {#if session.commandsError}
      <p class="error"><span class="glyph">▲</span> {session.commandsError}</p>
    {/if}
    <div class="scope">{session.summary.config.cwd}</div>
    <div class="list">
      {#each shown as c (c.name)}
        <button class="cmd-row" type="button" onclick={() => onPick(c)}>
          <span class="nm">{commandLabel(c)}</span>
          <span class="ds">{c.description}</span>
          <span class="ah">{c.argumentHint}</span>
        </button>
      {:else}
        <p class="muted">{session.commands.length ? "Nothing matches that search." : "No commands to show."}</p>
      {/each}
    </div>
  </div>
</div>
