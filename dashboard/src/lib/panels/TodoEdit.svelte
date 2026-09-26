<script lang="ts">
  import { untrack } from "svelte";
  import { ApiError } from "$lib/api";
  import { draftOf, isEmpty, patchOf } from "$lib/model/edit";
  import { thingId } from "$lib/model/types";
  import { snapshot } from "$lib/snapshot.svelte";
  import { ui } from "$lib/ui.svelte";
  import type { Draft, TodoThing, WhenKind } from "$lib/model/edit";

  type Props = { thing: TodoThing; tz: string; directives: readonly string[]; onclose: () => void };
  const { thing, tz, directives, onclose }: Props = $props();

  const WHENS: readonly { value: WhenKind; label: string }[] = [
    { value: "undated", label: "no date" },
    { value: "due", label: "due on" },
    { value: "daily", label: "every day" },
    { value: "event", label: "happens at" },
  ];

  // The drawer mounts one form per todo, so the todo it opened on is the one it edits. A
  // poll that lands mid-edit must not rewrite what is being typed.
  const was: Draft = untrack(() => draftOf(thing, tz));
  let draft = $state<Draft>({ ...was });
  let problem = $state("");
  let saving = $state(false);
  let first: HTMLInputElement | undefined = $state();

  $effect(() => {
    first?.focus();
    first?.select();
  });

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (saving) return;
    const out = patchOf(was, draft);
    if ("problem" in out) {
      problem = out.problem;
      return;
    }
    if (isEmpty(out.patch)) {
      onclose();
      return;
    }
    saving = true;
    problem = "";
    try {
      const id = await snapshot.editTodo(thing.todoId, out.patch);
      // A new text is a new id. Following it keeps the drawer on the todo that was just saved.
      ui.show(thingId(`todo:${id}`));
      onclose();
    } catch (cause) {
      problem = cause instanceof ApiError ? cause.detail : String(cause);
    } finally {
      saving = false;
    }
  }

  // Escape backs out of the form and leaves the drawer open. Stopping it here keeps the
  // window's handler, which closes the drawer, from seeing it when a button has focus.
  function keys(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    onclose();
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions (Escape bubbling up from its fields, not a control of its own) -->
<form class="edit" onsubmit={save} onkeydown={keys}>
  <label>
    <span>todo</span>
    <input bind:this={first} bind:value={draft.text} autocomplete="off" spellcheck="true" />
  </label>
  <label>
    <span>when</span>
    <span class="pair">
      <select bind:value={draft.when}>
        {#each WHENS as option (option.value)}<option value={option.value}>{option.label}</option>{/each}
      </select>
      {#if draft.when === "due"}
        <input type="date" bind:value={draft.due} aria-label="due date" />
      {:else if draft.when === "event"}
        <input type="datetime-local" bind:value={draft.at} aria-label="day and time" />
      {/if}
    </span>
  </label>
  <label>
    <span>directive</span>
    <input bind:value={draft.project} list="directives" placeholder="none" autocomplete="off" />
  </label>
  <datalist id="directives">
    {#each directives as name (name)}<option value={name}></option>{/each}
  </datalist>
  {#if problem !== ""}<p class="problem">{problem}</p>{/if}
  <div class="verbs">
    <button type="submit" disabled={saving}><kbd>⏎</kbd> {saving ? "saving" : "save"}</button>
    <button type="button" onclick={onclose}><kbd>esc</kbd> cancel</button>
  </div>
</form>
