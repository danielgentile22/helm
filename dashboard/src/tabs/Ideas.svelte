<script lang="ts">
  import { fetchJson, type IdeaStatus, type IdeasResponse } from "../lib/api";
  import { createPoll } from "../lib/poll.svelte";
  import CaptureSlot from "../ui/CaptureSlot.svelte";
  import LoadState from "../ui/LoadState.svelte";
  import IdeaRow from "./IdeaRow.svelte";

  let { at = $bindable() }: { at: number | null } = $props();

  const filters: { status: IdeaStatus; label: string; empty: string }[] = [
    { status: "open", label: "Open", empty: "No open ideas" },
    { status: "done", label: "Done", empty: "Nothing done yet" },
    { status: "dropped", label: "Dropped", empty: "Nothing dropped" },
    { status: "promoted", label: "Promoted", empty: "Nothing promoted" },
  ];

  let status = $state<IdeaStatus>("open");
  const filter = $derived(filters.find((f) => f.status === status) ?? filters[0]!);

  // One poll per filter, so a new filter starts from the skeleton, not the last filter's rows.
  const poll = $derived.by(() => {
    const path = `/api/ideas?status=${status}`;
    return createPoll(() => fetchJson<IdeasResponse>(path));
  });
  $effect(() => {
    const current = poll;
    current.start();
    return () => current.stop();
  });
  $effect(() => {
    at = poll.load.state === "ready" ? poll.load.at : null;
  });
</script>

<CaptureSlot />

<div class="chips" role="group" aria-label="Show ideas">
  {#each filters as f (f.status)}
    <button class="chip" aria-pressed={status === f.status} onclick={() => (status = f.status)}>{f.label}</button>
  {/each}
</div>

<LoadState
  load={poll.load}
  empty={filter.empty}
  isEmpty={(d) => d.ideas.length === 0 && d.errors.length === 0}
  onretry={() => poll.refresh()}
>
  {#snippet children(data, now)}
    {#if data.errors.length > 0}
      <div class="errors">
        <p>These idea notes could not be read:</p>
        <ul>
          {#each data.errors as error (error)}<li>{error}</li>{/each}
        </ul>
      </div>
    {/if}
    {#if data.ideas.length === 0}
      <p class="empty">{filter.empty}</p>
    {:else}
      <ul class="stack">
        {#each data.ideas as idea (idea.id)}
          <IdeaRow {idea} {now} />
        {/each}
      </ul>
    {/if}
  {/snippet}
</LoadState>

<style>
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 12px 0 16px;
  }
  .chip {
    min-height: 44px;
    padding: 0 14px;
    border-radius: 999px;
    border: 1px solid var(--line);
    background: var(--surface-2);
    color: var(--dim);
    font-size: 12px;
    cursor: pointer;
    transition: color 120ms, border-color 120ms, background-color 120ms;
  }
  .chip:hover {
    color: var(--ink);
  }
  .chip[aria-pressed="true"] {
    color: var(--accent);
    border-color: var(--accent-line);
    background: var(--accent-wash);
  }
  @media (min-width: 900px) {
    .chip {
      min-height: 36px;
    }
  }
  .errors {
    font-size: 12px;
    color: var(--warn);
    border: 1px solid color-mix(in srgb, var(--warn) 30%, transparent);
    border-radius: 10px;
    padding: 10px 14px;
    margin-bottom: 12px;
    overflow-wrap: anywhere;
  }
  .errors p {
    margin: 0 0 4px;
  }
  .errors ul {
    margin: 0;
    padding-left: 18px;
  }
</style>
