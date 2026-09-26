<script lang="ts">
  import Legend from "./Legend.svelte";
  import TodoEdit from "./TodoEdit.svelte";
  import { moveFocus } from "$lib/focus";
  import { glyphFor } from "$lib/model/derive";
  import { whenLine } from "$lib/model/detail";
  import { dueSoon } from "$lib/model/pressure";
  import { snapshot } from "$lib/snapshot.svelte";
  import { ui } from "$lib/ui.svelte";
  import { undo } from "$lib/undo.svelte";
  import type { Placed } from "$lib/model/pressure";
  import type { ThingId } from "$lib/model/types";

  type Props = { placed: Placed | null };
  const { placed }: Props = $props();

  const thing = $derived(placed?.thing ?? null);
  const shown = $derived(placed !== null || ui.legend);
  const kind = $derived(thing === null ? "" : thing.kind === "job" ? "routine" : thing.kind);
  // The full date beside the reason, unless the reason already names the day.
  const when = $derived(placed === null || thing === null ? "" : whenLine(placed.pressure.reason, thing.at, snapshot.model?.tz ?? "UTC"));

  // The directives this department already files todos under, offered as the form types.
  const directives = $derived.by((): string[] => {
    if (thing === null) return [];
    const names = (snapshot.model?.things ?? []).flatMap((t) =>
      t.kind !== "job" && t.dept === thing.dept && t.project !== null ? [t.project] : [],
    );
    return [...new Set(names)].sort();
  });

  function done(): void {
    if (thing === null || thing.kind === "job") return;
    undo.set(thing, true);
    ui.open(null);
  }

  // Focus follows the drawer. Opening puts it on the heading, so a screen reader reads the
  // title and the keys keep working (a heading is not a button that keeps its keys). Closing
  // hands it back to the title of the row last shown, or to whatever opened the drawer, and
  // backing out of the edit form puts it on the heading again. Only when focus was in the
  // drawer or nowhere: a click on another row keeps the focus it made.
  let aside: HTMLElement | undefined;
  let opener: HTMLElement | null = null;
  let last: ThingId | null = null;
  let wasShown = false;
  let wasEditing = false;

  function focusWasHere(): boolean {
    const at = document.activeElement;
    return at === null || at === document.body || (aside?.contains(at) ?? false);
  }

  function titleOf(id: ThingId | null): HTMLElement | null {
    if (id === null) return null;
    return document.querySelector<HTMLElement>(`.row[data-thing="${CSS.escape(id)}"] .t`);
  }

  $effect(() => {
    const on = shown;
    const editing = ui.editing && placed !== null;
    const id = placed?.thing.id ?? null;
    const heading = aside?.querySelector<HTMLElement>("h2") ?? null;
    if (on && !wasShown) {
      const at = document.activeElement;
      opener = at instanceof HTMLElement && at !== document.body && !(aside?.contains(at) ?? false) ? at : null;
      // An edit opened straight from the map focuses its own first field.
      if (!editing) moveFocus(heading);
    } else if (!on && wasShown) {
      if (focusWasHere()) moveFocus(titleOf(last) ?? (opener?.isConnected === true ? opener : null));
      opener = null;
    } else if (on && wasEditing && !editing && focusWasHere()) {
      moveFocus(heading);
    }
    wasShown = on;
    wasEditing = editing;
    if (id !== null) last = id;
  });
</script>

{#if shown}
  <button class="scrim" aria-label="close" onclick={() => ui.clear()}></button>
{/if}
<aside
  bind:this={aside}
  class="drawer"
  class:on={shown}
  aria-hidden={!shown}
  aria-label={ui.legend ? "legend" : "details"}
  tabindex="-1"
  inert={!shown}
>
  {#if ui.legend}
    <Legend />
  {:else if placed !== null && thing !== null}
    <div class="kind">{kind} · {thing.dept}{#if thing.kind !== "job" && thing.project !== null}{" · "}{thing.project}{/if}</div>
    {#if thing.kind !== "job" && ui.editing}
      {#key thing.id}
        <TodoEdit {thing} tz={snapshot.model?.tz ?? "UTC"} {directives} onclose={() => ui.stopEditing()} />
      {/key}
    {:else}
    <h2 tabindex="-1">{thing.label}</h2>
    <div class="reason" class:alarm={placed.pressure.late} class:soon={dueSoon(placed.pressure)}>
      {glyphFor(thing, placed.phase)} {placed.pressure.reason}{#if when !== ""}{" · "}{when}{/if}
    </div>
    {/if}
    {#if thing.kind !== "job" && !ui.editing}
      {#if thing.notes !== ""}<p class="notes">{thing.notes}</p>{/if}
      {#if thing.subs.length > 0}
        <ul class="subs">
          {#each thing.subs as sub (sub.text)}
            <li class:ok={sub.done}><span class="cb">{sub.done ? "■" : "□"}</span>{sub.text}</li>
          {/each}
        </ul>
      {/if}
      {#if thing.doneWhen !== null}
        <div class="pred" class:ok={thing.doneWhen.ok === true}>
          done when {thing.doneWhen.predicate}: {thing.doneWhen.detail}
        </div>
      {/if}
      <div class="path">{thing.path}:{thing.line}</div>
      <div class="verbs">
        <button onclick={done}><kbd>x</kbd> done</button>
        <button onclick={() => ui.edit(thing.id)}><kbd>e</kbd> edit</button>
        <button onclick={() => ui.open(null)}><kbd>esc</kbd> close</button>
      </div>
    {:else if thing.kind === "job"}
      <div class="path">{thing.path} · runs {thing.schedule}</div>
    {/if}
  {/if}
</aside>
