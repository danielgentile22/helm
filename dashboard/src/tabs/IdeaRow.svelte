<script lang="ts">
  import type { Idea } from "../lib/api";
  import { isUrl, type IdeaWrites, type PromoteTarget } from "../lib/ideas.svelte";
  import { daysAgo, dueLabel, localDate } from "../lib/time";

  let {
    idea,
    now,
    writes,
    target = null,
    projects = [],
  }: {
    idea: Idea;
    now: number;
    writes?: IdeaWrites;
    target?: PromoteTarget | null;
    /** Project titles the edit form offers; none means the project is not edited here. */
    projects?: string[];
  } = $props();

  const today = $derived(localDate(now));
  const issueIsLink = $derived(idea.issue !== null && isUrl(idea.issue));
  const pending = $derived(writes?.isPending(idea) ?? false);
  const error = $derived(writes?.errorOf(idea.id) ?? null);
  const editable = $derived(writes !== undefined && !pending && idea.status !== "promoted");

  let editingDue = $state(false);

  // Edit: a draft of what the idea says, sent as only the parts that changed.
  const TITLE_MAX = 200;
  const NOTES_MAX = 4000;
  let draft = $state<{ title: string; notes: string; project: string } | null>(null);
  let titleInput = $state<HTMLInputElement>();

  function startEdit(): void {
    draft = { title: idea.title, notes: idea.notes ?? "", project: idea.project ?? "" };
    queueMicrotask(() => titleInput?.focus());
  }

  async function saveEdit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (draft === null || writes === undefined) return;
    const title = draft.title.trim().replace(/\s+/g, " ");
    if (title === "") return;
    const notes = draft.notes.trim();
    const change: { title?: string; notes?: string | null; project?: string | null } = {};
    if (title !== idea.title) change.title = title;
    if (notes !== (idea.notes ?? "")) change.notes = notes || null;
    if (projects.length > 0 && draft.project !== (idea.project ?? "")) change.project = draft.project || null;
    draft = null;
    if (Object.keys(change).length > 0) await writes.edit(idea, change);
  }

  function editKey(event: KeyboardEvent): void {
    if (event.key === "Escape") draft = null;
  }

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
  {#if draft !== null}
    <form class="edit" onsubmit={saveEdit}>
      <input
        bind:this={titleInput}
        bind:value={draft.title}
        type="text"
        aria-label="Title"
        maxlength={TITLE_MAX}
        onkeydown={editKey}
        autocomplete="off"
      />
      <textarea bind:value={draft.notes} aria-label="Notes" placeholder="Notes" rows="3" maxlength={NOTES_MAX} onkeydown={editKey}
      ></textarea>
      <div class="edit-acts">
        {#if projects.length > 0}
          <select bind:value={draft.project} aria-label="Project" onkeydown={editKey}>
            <option value="">No project</option>
            {#if idea.project !== null && !projects.includes(idea.project)}
              <option value={idea.project}>{idea.project}</option>
            {/if}
            {#each projects as p (p)}<option value={p}>{p}</option>{/each}
          </select>
        {/if}
        <span class="grow"></span>
        <button type="button" class="act" onclick={() => (draft = null)}>Cancel</button>
        <button type="submit" class="btn primary" disabled={draft.title.trim() === ""}>Save</button>
      </div>
    </form>
  {:else}
  <div class="body">
    <div class="text">{idea.title}</div>
    {#if idea.notes !== null}<div class="notes">{idea.notes}</div>{/if}
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
        <button class="act" onclick={startEdit}>Edit</button>
      {/if}
    </div>
  {/if}
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
  .notes {
    margin-top: 2px;
    color: var(--dim);
    font-size: 13px;
    white-space: pre-line;
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .edit {
    flex: 1 1 100%;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .edit input,
  .edit textarea,
  .edit select {
    width: 100%;
    min-height: 40px;
    padding: 8px 10px;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: 8px;
    color: var(--ink);
    font: inherit;
    /* 16px keeps iOS Safari from zooming into the field */
    font-size: 16px;
  }
  .edit textarea {
    resize: vertical;
    line-height: 1.4;
  }
  .edit select {
    width: auto;
    max-width: 60%;
  }
  .edit-acts {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .grow {
    flex: 1;
  }
  @media (min-width: 900px) {
    .edit input,
    .edit textarea,
    .edit select {
      font-size: 14px;
    }
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
