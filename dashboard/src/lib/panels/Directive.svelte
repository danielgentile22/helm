<script lang="ts">
  import Detail from "./Detail.svelte";
  import Rail from "./Rail.svelte";
  import Row from "./Row.svelte";
  import Star from "./Star.svelte";
  import { NO_DETAIL, flowDetail } from "$lib/model/detail";
  import { leadTier } from "$lib/model/ink";
  import { summarize } from "$lib/model/pressure";
  import { ui } from "$lib/ui.svelte";
  import type { Directive } from "$lib/model/pressure";
  import type { Department } from "$lib/model/types";

  // A department's only directive leaves its rail and words to the department's head, which
  // would say exactly the same thing one line above.
  type Props = { directive: Directive; dept: Department; solo?: boolean };
  const { directive, dept, solo = false }: Props = $props();

  // A starred directive with nothing filed under it (ADR 0020). It is drawn so a priority
  // with nothing queued is not invisible, but it never nags (ADR 0007): no rail, no pull, no
  // hue, quieter than any cell that holds a todo. A click anywhere on it, or its "+", opens
  // quick add already filed under it.
  const idle = $derived(directive.things.length === 0 && directive.name !== null);

  function addHere(): void {
    if (directive.name !== null) ui.add(dept, directive.name);
  }

  function onIdleClick(event: MouseEvent): void {
    // The "+" is its own button; this is the rest of the cell.
    if (event.target instanceof Element && event.target.closest("button") !== null) return;
    addHere();
  }

  // A cell is as tall as what it holds. Its pull is carried by the size its lead is set at
  // (the tier), by its rail and the words beside it, and by its surface: a tier 1 or 2 cell
  // steps up to lit plane. A tier 4 cell has no lead; it is its rows.
  const tier = $derived(leadTier(directive.lead?.pressure ?? null));
  const lead = $derived(tier < 4 ? directive.lead : null);
  // Open things strongest first, then the done ones in deep ash.
  const rows = $derived([
    ...directive.things.filter((p) => p.pressure.value > 0 && p !== lead),
    ...directive.things.filter((p) => p.pressure.value === 0),
  ]);
  const words = $derived(summarize(directive.things));
  const done = $derived(directive.things.every((p) => p.pressure.value === 0));

  // The loudest tier shows the drawer's first lines under the lead: two lines of notes, the
  // subtask progress, the done-when check. Anything longer is the drawer's.
  const leadThing = $derived(lead !== null && tier === 1 && lead.thing.kind !== "job" ? lead.thing : null);
  const detail = $derived(leadThing === null ? NO_DETAIL : { ...flowDetail(leadThing), doneWhen: leadThing.doneWhen !== null });
  const detailed = $derived(detail.noteLines > 0 || detail.subs !== null || detail.doneWhen);
</script>

{#if idle}
  <!-- svelte-ignore a11y_click_events_have_key_events (the "+" is the keyboard's way in) -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <section class="cell idle" onclick={onIdleClick}>
    <div class="ch">
      <h3>{directive.name}</h3>
      {#if directive.star !== null}<Star rank={directive.star} />{/if}
      <span class="none">nothing queued</span>
      <button class="plus" aria-label="add a todo to {directive.name}" title="add a todo to {directive.name}" onclick={addHere}>+</button>
    </div>
  </section>
{:else}
<section class="cell t{tier}" class:done>
  <!-- The name, its star, and the pull on one line; the rail and its words drop under the
       name when the cell is too narrow for both. -->
  <div class="ch">
    <h3>{directive.name ?? "Unfiled"}</h3>
    {#if directive.star !== null}<Star rank={directive.star} />{/if}
    {#if !solo}
      <span class="pr">
        <Rail things={directive.things} />
        <span class="words" class:alarm={directive.late > 0}>{words}</span>
      </span>
    {/if}
  </div>
  {#if lead !== null}
    <div class="lead t{tier}">
      <Row placed={lead} progress={detail.subs === null} />
    </div>
    {#if leadThing !== null && detailed}
      <Detail thing={leadThing} {detail} />
    {/if}
  {/if}
  {#if rows.length > 0}
    <div class="rows">
      {#each rows as placed (placed.thing.id)}
        <Row {placed} compact />
      {/each}
    </div>
  {/if}
</section>
{/if}
