<script lang="ts">
  import { clock } from "$lib/clock.svelte";
  import { freshness, health } from "$lib/model/derive";
  import { duration, fmtTime } from "$lib/model/time";
  import { snapshot } from "$lib/snapshot.svelte";
  import type { Freshness, Ms, Source } from "$lib/model/types";

  type Props = { warnings?: readonly string[] };
  const { warnings = [] }: Props = $props();

  // Tapping is the only hover a phone has, so the drop is a toggle as well as a hover.
  let open = $state(false);

  function line(source: Source, freshness: Freshness, now: Ms, tz: string): string {
    switch (freshness.state) {
      case "fresh": {
        // Fresh carries no age, so read it off the source the check already looked at.
        const produced = source.produced;
        if (produced === null) return `${source.name} ok`;
        return `${source.name} ok ${duration(now - produced)} ago`;
      }
      case "stale":
        return `${source.name} STALE ${duration(freshness.ageMs)}`;
      case "failed": {
        const from = freshness.rowsFrom;
        const tail = from === null ? "no rows yet" : `rows from ${fmtTime(from, tz)}`;
        return `${source.name} FAILED ${freshness.reason}, ${tail}`;
      }
      case "never":
        return `${source.name} never produced rows`;
      default: {
        const unreachable: never = freshness;
        return unreachable;
      }
    }
  }

  const view = $derived.by(() => {
    void clock.minute;
    const now = clock.now();
    const model = snapshot.model;
    if (model === null) return { lines: [], health: { ok: true, label: "" } };
    const tz = model.tz;
    const lines = model.sources.map((source) => {
      const f = freshness(source, now);
      return { name: source.name, state: f.state, text: line(source, f, now, tz) };
    });
    return { lines, health: health(lines.map((l) => l.state)) };
  });

  const bad = $derived(!view.health.ok || warnings.length > 0);
</script>

{#if view.lines.length > 0 || warnings.length > 0}
  <div class="sources" class:open>
    <button class="health" class:ok={!bad} class:bad type="button" onclick={() => (open = !open)}>
      <span class="s"></span><span class="l">{view.health.label}</span>
    </button>
    <div class="drop">
      {#each view.lines as l (l.name)}
        <div class="flag {l.state}"><span class="s"></span>{l.text}</div>
      {/each}
      {#each warnings as text (text)}
        <div class="flag failed"><span class="s"></span>{text}</div>
      {/each}
    </div>
  </div>
{/if}
