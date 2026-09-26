<script lang="ts">
  import { ApiError } from "$lib/api";
  import { clock } from "$lib/clock.svelte";
  import { describe, knownDirectives, parseCapture } from "$lib/model/capture";
  import { thingId } from "$lib/model/types";
  import { snapshot } from "$lib/snapshot.svelte";
  import { ui } from "$lib/ui.svelte";

  // Long enough to find the new row on the map, short enough to be gone before it matters.
  const LIT_MS = 2000;

  let line = $state("");
  let saving = $state(false);
  let failed = $state("");
  let field: HTMLInputElement | undefined = $state();

  const preset = $derived(ui.adding?.dept ?? null);
  // A starred directive's own "+" opens the field under it. A typed #directive or department
  // word still wins; the preset only files a line that names neither.
  const presetDirective = $derived(ui.adding?.directive ?? null);
  const tz = $derived(snapshot.model?.tz ?? "UTC");
  const known = $derived(knownDirectives(snapshot.model?.things ?? [], snapshot.model?.directives ?? []));
  const parsed = $derived.by(() => {
    void clock.minute;
    const read = parseCapture(line, known, preset, clock.now(), tz);
    if (presetDirective !== null && "todo" in read && read.todo.project === null && read.todo.dept === preset) {
      return { todo: { ...read.todo, project: presetDirective } };
    }
    return read;
  });
  const dept = $derived("todo" in parsed ? parsed.todo.dept : preset);

  // One line under the field, always in the system voice: what Enter would write, why it
  // would not, or what the grammar is while there is nothing to read yet.
  const status = $derived.by((): { text: string; tone: "ok" | "faint" | "alarm" } => {
    if (saving) return { text: "saving", tone: "faint" };
    if (failed !== "") return { text: failed, tone: "alarm" };
    if (line.trim() === "") {
      const lead = preset === null ? "work, chess, projects or life · " : "";
      return { text: `${lead}#directive · fri · 9/30 · daily · at 7pm`, tone: "faint" };
    }
    if ("problem" in parsed) return { text: parsed.problem, tone: "faint" };
    return { text: describe(parsed.todo, known, clock.now(), tz), tone: "ok" };
  });

  // Every open is a fresh object, so a second n or + while the field is open, focus elsewhere,
  // brings the cursor back to it.
  $effect(() => {
    void ui.adding;
    field?.focus();
  });

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (saving || !("todo" in parsed)) return;
    const todo = parsed.todo;
    saving = true;
    failed = "";
    try {
      const id = await snapshot.addTodo(todo);
      ui.stopAdding();
      // The phone shows one department at a time, so it turns to the one that was written.
      if (ui.phone) ui.setPage(todo.dept);
      // The row lights the way a hover would, then lets go unless the pointer took it over.
      const lit = thingId(`todo:${id}`);
      ui.hover(lit);
      setTimeout(() => {
        if (ui.hovered === lit) ui.hover(null);
      }, LIT_MS);
    } catch (cause) {
      failed = cause instanceof ApiError ? cause.detail : String(cause);
    } finally {
      saving = false;
    }
  }

  // Escape closes the field and nothing else. Stopping it here keeps the window's handler,
  // which would close the drawer or unzoom the map, from seeing it.
  function keys(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.stopPropagation();
      ui.stopAdding();
    } else if (event.key === "Backspace" && line === "" && preset !== null) {
      // Backspace into an empty field drops the chosen directive, then the department, the
      // way it would delete a word typed at the start.
      ui.add(presetDirective === null ? null : preset);
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions (Escape bubbling up from its field, not a control of its own) -->
<form class="quick" onsubmit={submit} onkeydown={keys}>
  {#if preset !== null && dept !== null}<span class="chip">{dept}{#if presetDirective !== null && dept === preset}<span class="chip-d"> · {presetDirective}</span>{/if}</span>{/if}
  <input
    bind:this={field}
    bind:value={line}
    oninput={() => (failed = "")}
    placeholder="new todo"
    aria-label="new todo"
    aria-describedby="quick-status"
    autocomplete="off"
    spellcheck="true"
    enterkeyhint="done"
  />
  <span id="quick-status" class="parse {status.tone}" aria-live="polite" title={status.text}>{status.text}</span>
</form>
