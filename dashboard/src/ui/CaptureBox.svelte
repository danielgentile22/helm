<script lang="ts">
  import type { IdeaDraft } from "../lib/api";

  let {
    project = null,
    projects = [],
    onadd,
  }: {
    /** Set on a project's column: every idea added here is that project's, and no picker shows. */
    project?: string | null;
    /** Project titles for the picker; none means no picker. */
    projects?: string[];
    onadd: (draft: IdeaDraft) => Promise<string | null>;
  } = $props();

  const MAX = 200;
  let title = $state("");
  let due = $state("");
  let picked = $state("");
  let error = $state<string | null>(null);
  let input = $state<HTMLInputElement>();

  const extras = $derived(project === null && projects.length > 0);

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const text = title.trim();
    if (text === "") return;
    const draft: IdeaDraft = { title: text, project: project ?? (picked || null), due: due || null };
    // The row appears at once; the box is ready for the next idea while this one is sent.
    title = "";
    error = null;
    const failed = await onadd(draft);
    if (failed === null) {
      due = "";
      return;
    }
    error = failed;
    if (title === "") title = text;
    input?.focus();
  }
</script>

<form class="capture" data-slot="capture" onsubmit={submit}>
  <div class="line">
    <input
      bind:this={input}
      bind:value={title}
      type="text"
      placeholder={project === null ? "Throw an idea in" : `An idea for ${project}`}
      aria-label="Idea"
      maxlength={MAX}
      enterkeyhint="done"
      autocomplete="off"
      oninput={() => (error = null)}
    />
    <button type="submit" class="btn primary" disabled={title.trim() === ""}>Add</button>
  </div>
  {#if extras}
    <div class="extras">
      <label class="field">
        <select bind:value={picked} aria-label="Project">
          <option value="">No project</option>
          {#each projects as p (p)}<option value={p}>{p}</option>{/each}
        </select>
      </label>
      <label class="field">
        <span class="faint">Due</span>
        <input type="date" bind:value={due} />
      </label>
      {#if due !== ""}
        <button type="button" class="clear" onclick={() => (due = "")}>No due date</button>
      {/if}
    </div>
  {/if}
  {#if error !== null}<p class="notice" role="alert">{error}</p>{/if}
</form>

<style>
  .line {
    display: flex;
    gap: 8px;
  }
  .line input {
    flex: 1;
    min-width: 0;
    min-height: 44px;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: 10px;
    color: var(--ink);
    padding: 0 14px;
    font: inherit;
    font-size: 16px;
  }
  @media (min-width: 900px) {
    .line input {
      font-size: 14px;
    }
  }
  .line input::placeholder {
    color: var(--faint);
  }
  .line input:focus {
    border-color: var(--accent-line);
    outline: none;
  }
  .line button {
    min-height: 44px;
    padding: 0 16px;
  }
  .line button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .extras {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 14px;
    margin-top: 8px;
    font-size: 12px;
  }
  .field {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  select,
  .field input {
    min-height: 32px;
    max-width: 160px;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: 8px;
    color: var(--ink);
    padding: 0 8px;
    font: inherit;
  }
  .clear {
    min-height: 32px;
    border: 0;
    background: none;
    color: var(--dim);
    cursor: pointer;
    padding: 0 4px;
  }
  .clear:hover {
    color: var(--ink);
  }
  .notice {
    margin-top: 6px;
  }
</style>
