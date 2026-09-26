<script lang="ts">
  import Gate from "$lib/panels/Gate.svelte";
  import Map from "$lib/panels/Map.svelte";
  import Phone from "$lib/panels/Phone.svelte";
  import QuickAdd from "$lib/panels/QuickAdd.svelte";
  import SourceHealth from "$lib/panels/SourceHealth.svelte";
  import Start from "$lib/panels/Start.svelte";
  import Talk from "$lib/panels/Talk.svelte";
  import Undo from "$lib/panels/Undo.svelte";
  import { auth } from "$lib/auth.svelte";
  import { board } from "$lib/board.svelte";
  import { clock } from "$lib/clock.svelte";
  import { talk } from "$lib/talk.svelte";
  import { snapshot } from "$lib/snapshot.svelte";
  import { ui } from "$lib/ui.svelte";
  import { undo } from "$lib/undo.svelte";
  import { focusIsMoving } from "$lib/focus";
  import { step } from "$lib/model/cursor";
  import { DEPARTMENTS } from "$lib/model/types";
  import type { TodoThing } from "$lib/model/edit";

  const SKEW_FLOOR_MS = 60000;

  // Nothing is fetched until the door says the visitor is in, so a phone at the sign in
  // screen is not polling a 401 every minute behind it.
  const inside = $derived(auth.gate.name === "in");
  void auth.check();

  $effect(() => {
    if (!inside) return;
    const stopSnapshot = snapshot.start();
    const stopClock = clock.start();
    return () => {
      stopSnapshot();
      stopClock();
    };
  });

  const skew = $derived.by(() => {
    const skewMs = clock.skewMs;
    if (Math.abs(skewMs) <= SKEW_FLOOR_MS) return "";
    const minutes = Math.round(Math.abs(skewMs) / 60000);
    return `clock skew ${minutes}m ${skewMs > 0 ? "behind" : "ahead of"} the server`;
  });

  const dropped = $derived(snapshot.model?.dropped ?? 0);
  const droppedText = $derived(dropped === 0 ? "" : dropped === 1 ? "1 row dropped" : `${dropped} rows dropped`);

  // The phone has no room for the header's warning line, so they ride in the health drop.
  const warnings = $derived([skew, droppedText, snapshot.error ?? ""].filter((s) => s !== ""));

  // A screenshot wants a zoomed department without a keystroke, so ?sel=Projects does
  // on load exactly what pressing 3 does. Once, at init, not in an effect.
  const asked = new URLSearchParams(window.location.search).get("sel");
  const wanted = DEPARTMENTS.find((dept) => dept === asked);
  if (wanted !== undefined) ui.setZoom(wanted);

  // A letter, a digit or Escape only has to stay out of a field someone is typing into. A
  // checkbox is not one: it keeps focus after a click, and the keys must still work after a tick.
  function typing(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    if (target instanceof HTMLInputElement) return target.type !== "checkbox";
    return target.isContentEditable || ["TEXTAREA", "SELECT"].includes(target.tagName);
  }

  // A button or a tick someone tabbed to keeps its keys; one left focused by a click does
  // not. :focus-visible cannot tell them apart here, because Chrome turns it on for a clicked
  // button the moment a key is pressed on it, before this handler runs. So what a pointer
  // focused is remembered instead, and so is what the page focused itself (focus.ts: a row's
  // title when the drawer closes). A keydown clears the pending pointer, so a Tab after a
  // click on bare page is not mistaken for one.
  let pointing = false;
  let clicked: EventTarget | null = null;
  function tabbedTo(target: HTMLElement): boolean {
    return target.matches(":focus-visible") && target !== clicked;
  }

  // Space is stricter, because the browser fires it as a click on whatever button has focus
  // and this map is made of buttons. A clicked button or tick does not keep its space bar,
  // or reading a row in the drawer would kill the microphone for the rest of the session
  // while the indicator still said "hold space to talk", and a tick would untick itself.
  // The letters and Enter below draw the same line for a button.
  function spaceIsTaken(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    const tick = target instanceof HTMLInputElement && target.type === "checkbox";
    if (target.tagName === "BUTTON" || tick) return tabbedTo(target);
    return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
  }

  // j and k move the cursor, and an open drawer follows it, so the rows can be read one
  // after another. The first press with the drawer open lands on the row it shows.
  function move(delta: 1 | -1): void {
    const opened = ui.opened;
    const at = board.cursor === null && opened !== null ? board.order.indexOf(opened) : -1;
    const next = opened !== null && at >= 0 ? { id: opened, at } : step(board.order, board.cursor, delta);
    if (next === null) return;
    ui.point(next.id, next.at);
    if (opened !== null && !ui.editing) ui.show(next.id);
    const dept = board.find(next.id)?.thing.dept;
    if (ui.phone && dept !== undefined) ui.setPage(dept);
  }

  // x and e act on what the drawer shows when it is open, and on the cursor's row otherwise.
  function aimed(): TodoThing | null {
    const id = ui.opened ?? board.cursor;
    const thing = id === null ? null : board.find(id)?.thing ?? null;
    return thing === null || thing.kind === "job" ? null : thing;
  }

  // x ticks, or takes back a tick still waiting. It never unticks a daily already done: that
  // writes at once with no window, so it stays a deliberate click on the box. A tick from the
  // drawer closes it, as its done verb does.
  function tick(): void {
    const thing = aimed();
    if (thing === null) return;
    const done = !undo.waiting(thing.todoId);
    undo.set(thing, done);
    if (done && ui.opened === thing.id) ui.open(null);
  }

  function edit(): void {
    const thing = aimed();
    if (thing !== null && !ui.editing) ui.edit(thing.id);
  }

  // Keyed by event.key so a new key is a row here, not another branch.
  const KEYS: Record<string, () => void> = {
    j: () => move(1),
    ArrowDown: () => move(1),
    k: () => move(-1),
    ArrowUp: () => move(-1),
    x: tick,
    e: edit,
    u: () => undo.undoLast(),
    // An open field keeps its department; a new one starts in the one on screen, if any.
    n: () => ui.add(ui.adding?.dept ?? (ui.phone ? ui.pageDept : ui.zoom)),
    "?": () => ui.toggleLegend(),
    // The cursor's row when there is one; otherwise the start item, the header's one answer,
    // while the drawer is closed.
    Enter: () => {
      const start = board.start;
      if (board.cursor !== null) ui.open(board.cursor);
      else if (start !== null && ui.opened === null) ui.open(start.thing.id);
    },
  };

  function onKey(event: KeyboardEvent): void {
    pointing = false;
    if (event.key === " ") {
      // Shift+Space is page up and Cmd+Space belongs to the OS, so only a bare Space talks.
      if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
      if (event.repeat || spaceIsTaken(event.target)) return;
      event.preventDefault();
      void talk.press();
      return;
    }
    if (typing(event.target)) return;
    const n = Number(event.key);
    if (n >= 1 && n <= 4) {
      const dept = DEPARTMENTS[n - 1];
      if (dept !== undefined) ui.setZoom(dept);
    } else if (event.key === "Escape") {
      talk.cancel();
      // The quick add field first; its own handler catches Escape while it has focus.
      if (ui.adding !== null) ui.stopAdding();
      else ui.clear();
    } else if (!event.metaKey && !event.ctrlKey && !event.altKey) {
      const run = KEYS[event.key];
      if (run === undefined) return;
      // A button someone tabbed to keeps its keys, the same line Space draws, and a held
      // Enter must not open and close the drawer on every repeat.
      const target = event.target;
      if (target instanceof HTMLElement && target.tagName === "BUTTON" && tabbedTo(target)) return;
      if (event.key === "Enter" && (event.shiftKey || event.repeat)) return;
      // Stopped here, so an e or an n never lands in the field it is about to focus.
      event.preventDefault();
      run();
    }
  }

  // Unguarded: release() is a no-op unless the microphone is hot, and that closes the case
  // where focus moved to a button between the two halves of the keystroke.
  function onKeyUp(event: KeyboardEvent): void {
    if (event.key === " ") talk.release();
  }
</script>

<svelte:window
  onkeydown={onKey}
  onkeyup={onKeyUp}
  onblur={() => talk.drop()}
  onpointerdown={() => { pointing = true; }}
  onfocusin={(event) => { clicked = pointing || focusIsMoving() ? event.target : null; pointing = false; }}
/>
<svelte:document onvisibilitychange={() => { if (document.hidden) talk.drop(); }} />

{#if !inside}
  <Gate />
{:else if ui.phone}
  <Phone {warnings} />
{:else}
<div class="page">
  <header>
    <span class="mark">HELM</span>
    <!-- The field takes the middle of the header while it is open: the day, the start or
         undo line and the warnings step aside for the length of one line and come back
         when it closes. -->
    {#if ui.adding !== null}
      <QuickAdd />
    {:else if board.today !== null}
      {@const { late, today } = board.today.tally}
      <span class="today">
        <span class="date">{board.today.date}</span>
        <span class="count">
          {#if late === 0 && today === 0}
            <span class="quiet">nothing due today</span>
          {:else}
            {#if late > 0}<span class="late">{late} late</span>{/if}
            {#if late > 0 && today > 0}<span class="sep">·</span>{/if}
            {#if today > 0}<span>{today} today</span>{/if}
          {/if}
        </span>
      </span>
      <!-- A tick waiting out its undo window takes the start line's place, and the start
           line comes back when nothing is pending. -->
      {#if undo.banner !== null}
        <Undo />
      {:else}
        <Start />
      {/if}
    {/if}
    {#if ui.adding === null}
      {#if skew !== ""}<span class="warn">{skew}</span>{/if}
      {#if droppedText !== ""}<span class="warn">{droppedText}</span>{/if}
      {#if snapshot.error !== null}<span class="warn">{snapshot.error}</span>{/if}
      <!-- The spare room, and the keys in it whenever they fit whole. The room only takes what
           the rest leaves, so the keys never squeeze the start line: when they do not fit they
           wrap onto a second line the room clips, and are the first thing the header drops. -->
      <span class="room">
        <span class="keys"><kbd>j</kbd><kbd>k</kbd> move · <kbd>⏎</kbd> open · <kbd>x</kbd> done · <kbd>e</kbd> edit · <kbd>?</kbd> keys</span>
      </span>
    {/if}
    <Talk />
    <SourceHealth {warnings} />
  </header>
  <Map />
</div>
{/if}
