<script lang="ts">
  import { PERMISSION_MODES, type PermissionMode } from "../../shared/protocol";
  import type { HelmClient } from "../api";
  import Sheet from "../components/Sheet.svelte";
  import { fmtK, fmtTime, shortModel, shortPath } from "../format";
  import type { ThreadView } from "../fold";

  let { api, view, onClose }: { api: HelmClient; view: ThreadView; onClose: () => void } = $props();

  const MODE_WORDS: Record<PermissionMode, string> = { ask: "Ask before gated tools", bypass: "Bypass (run everything)" };

  let mode = $state<PermissionMode | null>(null);
  let modeError = $state("");

  const current = $derived(mode ?? view.config.permissionMode);

  async function setMode(next: PermissionMode): Promise<void> {
    mode = next;
    try {
      await api.patchThread(view.config.threadId, { permissionMode: next });
      modeError = "";
    } catch (err) {
      mode = null;
      modeError = err instanceof Error ? err.message : String(err);
    }
  }

  // The log is the only record of what this thread has run on: every model change
  // left a note behind, and the config carries whatever it is running on now.
  const history = $derived([
    ...view.turns.flatMap((t) => t.items).flatMap((l) => (l.kind === "note" ? [l.text.match(/^(\[[^\]]*\]).*?\b(model set to \S+)/)] : [])).flatMap((m) => (m ? [`${m[1]} ${m[2]}`] : [])),
    `now ${shortModel(view.config.model)} · ${view.config.effort}`,
  ]);

  const permissionHistory = $derived(
    view.turns
      .flatMap((t) => t.items)
      .flatMap((l) => (l.kind === "note" ? [l.text.match(/^(\[[^\]]*\]).*?\b(permissions set to \S+)/)] : []))
      .flatMap((m) => (m ? [`${m[1]} ${m[2]}`] : [])),
  );

  const totals = $derived(view.usageTotal);
</script>

<Sheet {onClose}>
  <div class="grab"></div>
  <h2>Thread info</h2>
  <div class="info">
    <div class="irow"><span class="k">Working directory</span><span class="v">{shortPath(view.config.cwd)}</span></div>
    <div class="irow"><span class="k">Created</span><span class="v">{fmtTime(view.config.createdAt)}</span></div>
    <div class="irow"><span class="k">Session</span><span class="v">{view.sessionId ?? "not bound yet"}</span></div>
    <div class="irow">
      <span class="k">Model</span>
      <span class="v">{#each history as h, i (i)}<span class="hline">{h}</span>{/each}</span>
    </div>
    <div class="irow">
      <span class="k">Permissions</span>
      <span class="v">
        <span class="seg">
          {#each PERMISSION_MODES as m (m)}
            <button aria-pressed={current === m} onclick={() => void setMode(m)}>{MODE_WORDS[m]}</button>
          {/each}
        </span>
        <span class="hline note">applies to the next tool decision</span>
        {#each permissionHistory as h, i (i)}<span class="hline">{h}</span>{/each}
        {#if modeError}<span class="hline error">{modeError}</span>{/if}
      </span>
    </div>
    {#if totals}
      <div class="irow"><span class="k">Input</span><span class="v">{fmtK(totals.inputTokens)}</span></div>
      <div class="irow"><span class="k">Output</span><span class="v">{fmtK(totals.outputTokens)}</span></div>
      <div class="irow"><span class="k">Cache read</span><span class="v">{fmtK(totals.cacheReadTokens)}</span></div>
      <div class="irow"><span class="k">Cache write</span><span class="v">{fmtK(totals.cacheWriteTokens)}</span></div>
    {/if}
  </div>
  <div class="actions">
    <span class="grow"></span>
    <button class="btn" onclick={onClose}>Close</button>
  </div>
</Sheet>
