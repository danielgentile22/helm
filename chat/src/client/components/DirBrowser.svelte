<script lang="ts">
  import type { DirEntry } from "../../shared/protocol";
  import type { HelmClient } from "../api";
  import { shortPath } from "../format";

  let { api, initial, onPick }: { api: HelmClient; initial: string; onPick: (path: string) => void } = $props();

  let roots: readonly DirEntry[] = [];
  let cwd = $state("/");
  let parent = $state<string | null>(null);
  let entries = $state<readonly DirEntry[]>([]);
  let err = $state("");

  const parentOf = (p: string): string => p.replace(/\/[^/]+$/, "") || "/";

  async function browse(path: string, from: string | null): Promise<void> {
    cwd = path;
    parent = from;
    try {
      entries = from === null && path === "" ? roots : await api.browseDirs(path);
      err = "";
    } catch (e) {
      entries = [];
      err = e instanceof Error ? e.message : String(e);
    }
    onPick(path);
  }

  $effect(() => {
    void (async () => {
      roots = await api.browseDirs();
      const start = initial || roots.find((r) => /Vault$/.test(r.path))?.path || roots[0]?.path || "/";
      await browse(start, roots.some((r) => r.path === start) ? "" : parentOf(start));
    })();
  });
</script>

<div class="crumb">{shortPath(cwd)}</div>
<div class="dirs">
  {#if parent !== null}
    <button onclick={() => void browse(parent!, roots.some((r) => r.path === parent) ? "" : parentOf(parent!))}>..</button>
  {/if}
  {#each entries as d (d.path)}
    <button onclick={() => void browse(d.path, cwd)}>{d.name}<span class="flags">{[d.hasClaudeMd ? "CLAUDE.md" : "", d.isGitRepo ? "git" : ""].filter(Boolean).join(" ")}</span></button>
  {/each}
</div>
{#if err}<p class="error">▲ {err}</p>{/if}
