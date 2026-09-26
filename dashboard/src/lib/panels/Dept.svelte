<script lang="ts">
  import Directive from "./Directive.svelte";
  import Rail from "./Rail.svelte";
  import { DEPARTMENTS } from "$lib/model/types";
  import { ui } from "$lib/ui.svelte";
  import type { DeptView } from "$lib/model/pressure";

  // A department is its corner and as tall as what it holds. Its header is the name, the key
  // that zooms it, the rail of everything it holds and the same pull in words; its directives
  // sit under it, two across on the desk and one on the phone.
  type Props = { view: DeptView; flow?: boolean };
  const { view, flow = false }: Props = $props();

  const key = $derived(DEPARTMENTS.indexOf(view.dept) + 1);
  const quiet = $derived(view.open === 0);
  const things = $derived(view.directives.flatMap((d) => d.things));
  // A starred directive with nothing under it sits after the cells that hold something, one
  // slim line each across the department's width, so it never takes a column from real work.
  const filled = $derived(view.directives.filter((d) => d.things.length > 0));
  const idle = $derived(view.directives.filter((d) => d.things.length === 0));

  function onBackground(event: MouseEvent): void {
    // The phone has no zoom, and a tap on the background is how you scroll past it.
    if (ui.phone) return;
    const target = event.target;
    if (target instanceof Element && target.closest("button, input, label, .cell") !== null) return;
    ui.setZoom(view.dept);
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<section
  class="dept"
  class:quiet
  class:zoomed={ui.zoom === view.dept}
  class:flow
  data-dept={view.dept}
  onclick={onBackground}
>
  <!-- The heading is the name alone, so a screen reader hears "Work", not "Work 1 1 due
       soon +". The key, the rail and the "+" sit beside it. -->
  <div class="dh">
    <h2>{view.dept}</h2>
    {#if !flow}<kbd aria-hidden="true" title="press {key} to zoom">{key}</kbd>{/if}
    <span class="pull">
      <Rail {things} />
      <span class="n" class:alarm={view.late > 0}>{view.summary}</span>
    </span>
    {#if !flow}
      <button class="plus" aria-label="add a todo to {view.dept}" title="add a todo (n)" onclick={() => ui.add(view.dept)}>+</button>
    {/if}
    {#if ui.zoom === view.dept}
      <button class="back" onclick={() => ui.setZoom(view.dept)}><kbd>esc</kbd> all four</button>
    {/if}
  </div>
  {#if filled.length > 0}
    <div class="cells" class:multi={filled.length > 1}>
      {#each filled as directive (directive.name ?? "")}
        <Directive {directive} dept={view.dept} solo={filled.length === 1} />
      {/each}
    </div>
  {/if}
  {#if idle.length > 0}
    <div class="cells idle">
      {#each idle as directive (directive.name ?? "")}
        <Directive {directive} dept={view.dept} />
      {/each}
    </div>
  {/if}
</section>
