<script lang="ts">
  import Glyph from "./Glyph.svelte";
  import { board } from "$lib/board.svelte";
  import { calm, columns as columnsOf, linesOf, nextUp } from "$lib/model/ink";
  import { fitRows } from "$lib/model/layout";
  import { fmtTime } from "$lib/model/time";
  import { snapshot } from "$lib/snapshot.svelte";
  import { ui } from "$lib/ui.svelte";
  import type { LateCount } from "$lib/model/ink";
  import type { Placed } from "$lib/model/pressure";
  import type { ThingId } from "$lib/model/types";

  // The week across all four departments: what is late, then what lands on each of the next
  // seven days. It is as tall as its busiest column and no taller (ADR 0026, amended): the
  // map hands it `spare`, the height the departments leave, and it hands back `want`, the
  // height it needs. Runs of empty days fold into one column, and the late column counts
  // what the map already shows instead of listing it twice. On the best day (nothing late,
  // nothing today) it says so in words and names what lands next. On the phone it is a page
  // of its own, a list rather than columns.
  type Props = { flow?: boolean; spare?: number; want?: number };
  let { flow = false, spare = Infinity, want = $bindable(0) }: Props = $props();

  const ITEM_H = 24;
  const ROOMY_ITEM_H = 62;
  // A quiet week is roomy: each item says where it is filed and its title may take two lines.
  const ROOMY_MAX = 3;
  const DAY_HEAD_H = 30;
  const GAP = 16;
  const FLOOR = 10;
  // The band's own padding, top and bottom, in shell.css (.map .band).
  const BAND_PAD = 48;

  const w = $derived(board.week);
  const tz = $derived(snapshot.model?.tz ?? "UTC");
  const isCalm = $derived(w !== null && calm(w));
  const next = $derived(w === null ? null : nextUp(w));

  // Every row the map draws (all four departments; the band is hidden while one is zoomed).
  const drawn = $derived(new Set<ThingId>(board.views.flatMap((v) => v.directives.flatMap((d) => d.things.map((p) => p.thing.id)))));
  const columns = $derived(w === null ? [] : columnsOf(w, (id) => drawn.has(id)));
  const busiest = $derived(Math.max(1, ...columns.map(linesOf)));
  // A column with nothing in it (a clear day, a folded span) takes a narrower share, so the
  // days that hold something get the width their titles need.
  const template = $derived(columns.map((c) => (c.kind === "span" || c.items.length + (c.kind === "late" ? c.counts.length : 0) === 0 ? "minmax(0, .6fr)" : "minmax(0, 1fr)")).join(" "));

  let height = $state(0);
  let headH = $state(0);
  let tallest = $state(0);
  let daysEl = $state<HTMLOListElement | undefined>(undefined);
  const room = $derived(Math.max(ITEM_H, height - headH - GAP - DAY_HEAD_H));

  // Roomy only when the week is quiet and the departments leave room for it at its most
  // generous; otherwise every item is one 24px line.
  const roomy = $derived(!flow && busiest <= ROOMY_MAX && headH + GAP + DAY_HEAD_H + busiest * ROOMY_ITEM_H + FLOOR + BAND_PAD <= spare);

  // The height the band asks the grid for. Compact, it is counted (every line is 24px) and
  // never less than the tallest column as drawn, which is taller only when a folded span's
  // label wraps. Roomy, a title may take one line or two, so it is the tallest column as
  // drawn; roomy shows every item whatever the band's height, so that measure never depends
  // on the answer, and a compact column cut to fit is never taller than the count.
  $effect(() => {
    if (flow) return;
    const measured = tallest > 0 ? headH + GAP + tallest + FLOOR + BAND_PAD : 0;
    const counted = headH + GAP + DAY_HEAD_H + busiest * ITEM_H + FLOOR + BAND_PAD;
    want = roomy && measured > 0 ? measured : Math.max(counted, measured);
  });

  $effect(() => {
    void columns;
    void roomy;
    void height;
    if (daysEl === undefined || flow) return;
    let max = 0;
    for (const el of daysEl.querySelectorAll<HTMLElement>(":scope > .day > .dc")) max = Math.max(max, el.offsetHeight);
    tallest = max;
  });

  const facts = $derived.by(() => {
    if (w === null) return "";
    const parts: string[] = [];
    if (w.dailies.total > 0) parts.push(`dailies ${w.dailies.done} of ${w.dailies.total} done`);
    if (w.undated > 0) parts.push(`${w.undated} undated on the map`);
    return parts.join(" · ");
  });

  function when(p: Placed): string {
    return p.thing.kind === "event" && p.thing.at !== null ? fmtTime(p.thing.at, tz) : "";
  }

  function where(p: Placed): string {
    const t = p.thing;
    return t.kind !== "job" && t.project !== null ? `${t.dept} · ${t.project}` : t.dept;
  }

  function fitOf(count: number): { shown: number; more: number } {
    return flow || roomy ? { shown: count, more: 0 } : fitRows(count, room, ITEM_H);
  }
</script>

{#snippet item(p: Placed)}
  <li>
    <button
      class="wi {p.thing.kind}"
      class:late={p.pressure.late}
      class:lit={ui.opened === p.thing.id || board.cursor === p.thing.id}
      title="{p.thing.label} · {where(p)} · {p.pressure.reason}"
      onclick={() => ui.open(p.thing.id)}
    >
      <Glyph thing={p.thing} phase={p.phase} />
      <span class="t">{p.thing.label}</span>
      {#if when(p) !== ""}<span class="tm">{when(p)}</span>{/if}
      {#if roomy}<span class="wh-at">{where(p)}</span>{/if}
    </button>
  </li>
{/snippet}

{#snippet count(c: LateCount)}
  {@const first = c.items[0]}
  <li>
    <button
      class="wi late count"
      class:lit={c.items.some((p) => ui.opened === p.thing.id || board.cursor === p.thing.id)}
      title={c.items.map((p) => `${p.thing.label} · ${p.pressure.reason}`).join("\n")}
      onclick={() => { if (first !== undefined) ui.open(first.thing.id); }}
    >
      <span class="g" aria-hidden="true">▲</span>
      <span class="t">{c.items.length} late · {c.dept}</span>
      <span class="sr">, on the map; opens {first?.thing.label ?? "it"}</span>
    </button>
  </li>
{/snippet}

{#if w !== null}
  <section class="week" class:calm={isCalm} class:flow class:roomy aria-label="the week" bind:clientHeight={height}>
    <div class="wh" bind:clientHeight={headH}>
      {#if isCalm}
        <p class="big">Nothing late, nothing due today.</p>
        <p class="sub">
          {#if next !== null}
            next up <button class="nx" onclick={() => ui.open(next.item.thing.id)}>{next.item.thing.label}</button>
            <span class="d">{next.day.label}</span>
          {:else}
            nothing dated in the next seven days
          {/if}
        </p>
      {:else}
        <h2>This week</h2>
      {/if}
      {#if facts !== ""}<span class="facts">{facts}</span>{/if}
    </div>
    <ol class="days" style="--tpl:{template}" bind:this={daysEl}>
      {#each columns as col (col.key)}
        {#if col.kind === "span"}
          <li class="day none span">
            <div class="dc">
              <div class="dl"><span>{col.from}</span> <span>to {col.to}</span></div>
              <div class="clear">clear</div>
            </div>
          </li>
        {:else if col.kind === "late"}
          <!-- Counts first, since they point at rows already on the map; anything late the map
               is not showing is listed by name after them. -->
          {@const fit = fitOf(col.counts.length + col.items.length)}
          {@const counts = col.counts.slice(0, fit.shown)}
          {@const items = col.items.slice(0, Math.max(0, fit.shown - counts.length))}
          <li class="day late">
            <div class="dc">
              <div class="dl">late<span class="c">{col.total}</span></div>
              <ul>
                {#each counts as c (c.dept)}{@render count(c)}{/each}
                {#each items as p (p.thing.id)}{@render item(p)}{/each}
              </ul>
              {#if fit.more > 0}<div class="more">+{fit.more} more</div>{/if}
            </div>
          </li>
        {:else}
          {@const fit = fitOf(col.items.length)}
          <li class="day" class:today={col.today} class:none={col.items.length === 0}>
            <div class="dc">
              <div class="dl">{col.label}{#if col.items.length > 0}<span class="c">{col.items.length}</span>{/if}</div>
              {#if col.items.length > 0}
                <ul>
                  {#each col.items.slice(0, fit.shown) as p (p.thing.id)}{@render item(p)}{/each}
                </ul>
                {#if fit.more > 0}<div class="more">+{fit.more} more</div>{/if}
              {:else}
                <div class="clear">clear</div>
              {/if}
            </div>
          </li>
        {/if}
      {/each}
    </ol>
  </section>
{/if}
