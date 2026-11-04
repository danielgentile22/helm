<script lang="ts">
  import type { Idea } from "../lib/api";
  import { isUrl, type IdeaWrites, type PromoteTarget } from "../lib/ideas.svelte";
  import { daysAgo, dueLabel, localDate } from "../lib/time";

  let {
    idea,
    now,
    writes,
    target = null,
  }: { idea: Idea; now: number; writes?: IdeaWrites; target?: PromoteTarget | null } = $props();

  const today = $derived(localDate(now));
  const issueIsLink = $derived(idea.issue !== null && isUrl(idea.issue));
  const pending = $derived(writes?.isPending(idea) ?? false);
  const error = $derived(writes?.errorOf(idea.id) ?? null);
  const editable = $derived(writes !== undefined && !pending && idea.status !== "promoted");

  let editingDue = $state(false);

  // Promote: pick a repo when there are several, say yes for a repo someone else owns.
  type Step = { at: "idle" } | { at: "pick"; repos: string[] } | { at: "confirm"; repo: string } | { at: "sending" };
  let step = $state<Step>({ at: "idle" });

  function startPromote(): void {
    if (target?.tracker === "github" && target.repos.length > 1) step = { at: "pick", repos: target.repos };
    else void promote({});
  }

  async function promote(body: { repo?: string; confirm?: boolean }): Promise<void> {
    if (writes === undefined) return;
    step = { at: "sending" };
    const result = await writes.promote(idea, body);
    step = result.kind === "confirm" ? { at: "confirm", repo: result.repo } : { at: "idle" };
  }

  function pickDue(event: Event): void {
    const value = (event.currentTarget as HTMLInputElement).value;
    if (value === "" || writes === undefined) return;
    editingDue = false;
    void writes.setDue(idea, value);
  }

  function clearDue(): void {
    editingDue = false;
    void writes?.setDue(idea, null);
  }
</script>

<li class="card idea" class:pending aria-busy={pending}>
  <div class="body">
    <div class="text">{idea.title}</div>
    <div class="sub">
      {idea.project ?? idea.department}
      {#if idea.due !== null}
        · <span class:warn-text={idea.status === "open" && idea.due <= today}>{dueLabel(idea.due, today)}</span>
      {/if}
      · {pending ? "adding" : daysAgo(idea.created, today)}
    </div>
    {#if idea.issue !== null}
      <div class="sub">
        {#if issueIsLink}
          <a class="link issue" href={idea.issue} target="_blank" rel="noopener">Open the issue</a>
        {:else}
          issue at {idea.issue}
        {/if}
      </div>
    {/if}
  </div>

  {#if editable && writes !== undefined}
    <div class="acts">
      {#if step.at === "sending"}
        <button class="act" disabled>Promoting</button>
      {:else if step.at === "pick"}
        <span class="ask">File the issue in which repo?</span>
        {#each step.repos as repo (repo)}
          <button class="act" onclick={() => promote({ repo })}>{repo}</button>
        {/each}
        <button class="act" onclick={() => (step = { at: "idle" })}>Cancel</button>
      {:else if step.at === "confirm"}
        {@const repo = step.repo}
        <span class="ask">Other people read {repo}. File this idea there as an issue?</span>
        <button class="btn primary" onclick={() => promote({ repo, confirm: true })}>File the issue</button>
        <button class="act" onclick={() => (step = { at: "idle" })}>Cancel</button>
      {:else if editingDue}
        <input
          type="date"
          aria-label="Due date"
          value={idea.due ?? ""}
          onchange={pickDue}
          onkeydown={(e) => e.key === "Escape" && (editingDue = false)}
        />
        {#if idea.due !== null}<button class="act" onclick={clearDue}>Clear</button>{/if}
        <button class="act" onclick={() => (editingDue = false)}>Cancel</button>
      {:else}
        {#if idea.status === "open"}
          <button class="act" onclick={() => writes.setStatus(idea, "done")}>Done</button>
          <button class="act" onclick={() => writes.setStatus(idea, "dropped")}>Drop</button>
          {#if target !== null && idea.project !== null}
            <button class="act" onclick={startPromote}>Promote</button>
          {/if}
        {:else}
          <button class="act" onclick={() => writes.setStatus(idea, "open")}>Reopen</button>
        {/if}
        <button class="act" onclick={() => (editingDue = true)}>{idea.due === null ? "Set due" : "Change due"}</button>
      {/if}
    </div>
  {/if}
  {#if error !== null}<p class="notice row-error" role="alert">{error}</p>{/if}
</li>

<style>
  .idea {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
  }
  .body {
    flex: 1 1 240px;
    min-width: 0;
  }
  .text {
    overflow-wrap: anywhere;
  }
  .pending {
    opacity: 0.6;
  }
  .issue {
    color: var(--accent);
  }
  .acts {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    margin: -4px -6px -4px auto;
  }
  .act {
    min-height: 40px;
    padding: 0 10px;
    border: 1px solid transparent;
    border-radius: 8px;
    background: none;
    color: var(--dim);
    font-size: 12px;
    cursor: pointer;
    transition: color 120ms, border-color 120ms, background-color 120ms;
  }
  .act:hover {
    color: var(--ink);
    border-color: var(--line);
    background: var(--surface-2);
  }
  input[type="date"] {
    min-height: 40px;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: 8px;
    color: var(--ink);
    padding: 0 8px;
    font: inherit;
    font-size: 12px;
  }
  @media (min-width: 900px) {
    .act,
    input[type="date"] {
      min-height: 28px;
    }
  }
  .act:disabled {
    opacity: 0.55;
    cursor: default;
  }
  .ask {
    flex-basis: 100%;
    font-size: 12px;
    color: var(--dim);
    padding-left: 6px;
  }
  @media (min-width: 900px) {
    .ask {
      flex-basis: auto;
    }
  }
  .row-error {
    flex-basis: 100%;
    margin: 0;
  }
</style>
