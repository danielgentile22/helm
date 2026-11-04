<script lang="ts">
  import { fetchJson, type IdeaDraft, type IdeaStatus, type IdeasResponse, type ProjectsResponse } from "../lib/api";
  import { createIdeaWrites, promoteTarget, type PromoteTarget } from "../lib/ideas.svelte";
  import { createPoll } from "../lib/poll.svelte";
  import CaptureBox from "../ui/CaptureBox.svelte";
  import LoadState from "../ui/LoadState.svelte";
  import Toast from "../ui/Toast.svelte";
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

  const writes = createIdeaWrites({
    refresh: () => poll.refresh(),
    signedOut: (failure) => poll.signedOut(failure),
  });

  // The picker offers projects that have a note, since an idea names its project by title.
  // Promote shows on an idea whose project has a tracker to promote to.
  let projects = $state<string[]>([]);
  let targets = $state<Record<string, PromoteTarget | null>>({});
  $effect(() => {
    void fetchJson<ProjectsResponse>("/api/projects").then((answer) => {
      if (answer.state === "ready") {
        const named = answer.data.projects.filter((p) => p.note !== null);
        projects = named.map((p) => p.title).sort();
        targets = Object.fromEntries(named.map((p) => [p.title, promoteTarget(p)]));
      }
    });
  });

  function add(draft: IdeaDraft): Promise<string | null> {
    // A new idea is open, so the list that will show it is the open one.
    status = "open";
    return writes.add(draft);
  }
</script>

<CaptureBox {projects} onadd={add} />

<div class="chips" role="group" aria-label="Show ideas">
  {#each filters as f (f.status)}
    <button class="chip" aria-pressed={status === f.status} onclick={() => (status = f.status)}>{f.label}</button>
  {/each}
</div>

<LoadState
  load={poll.load}
  empty={filter.empty}
  isEmpty={() => false}
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
    {@const ideas = writes.view(data.ideas, (i) => i.status === status)}
    {#if ideas.length === 0}
      <p class="empty">{filter.empty}</p>
    {:else}
      <ul class="stack">
        {#each ideas as idea (idea.id)}
          <IdeaRow {idea} {now} {writes} target={idea.project === null ? null : (targets[idea.project] ?? null)} />
        {/each}
      </ul>
    {/if}
  {/snippet}
</LoadState>

<Toast toast={writes.toast} />

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
