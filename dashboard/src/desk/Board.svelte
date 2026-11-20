<script lang="ts">
  import type { T3Finished, T3Response, T3Thread } from "../lib/api";

  let { threads, now, stale }: { threads: T3Response | null; now: number; stale: boolean } = $props();

  // Row heights in px, shared with the CSS below through style variables, so the count that
  // fits is worked out rather than clipped: the board never scrolls and never cuts a row.
  const HEAD = 30;
  const ROW = 58;
  const DONE = 34;
  const MORE = 24;
  const GAP = 14;

  let height = $state(0);

  function since(iso: string | null): number | null {
    const at = iso === null ? NaN : Date.parse(iso);
    return Number.isNaN(at) ? null : Math.max(0, now - at);
  }

  function span(ms: number | null): string {
    if (ms === null) return "";
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
    return `${Math.floor(h / 24)}d ${h % 24}h`;
  }

  function ago(ms: number | null): string {
    if (ms === null) return "";
    if (ms < 60_000) return "just now";
    return `${span(ms).split(" ")[0]} ago`;
  }

  type Plan = { waiting: number; running: number; finished: number };

  /** How many of each list fit, waiting first, then running, then finished. A list that
   *  is cut short keeps a line for "and N more". */
  const plan = $derived.by((): Plan => {
    const w = threads?.waiting.length ?? 0;
    const r = threads?.running.length ?? 0;
    const f = threads?.finished.length ?? 0;
    let room = height;
    let first = true;
    // The gap sits between groups, so only a group after the first pays for one.
    const take = (count: number, row: number, always: boolean): number => {
      if (count === 0 && !always) return 0;
      room -= HEAD + (first ? 0 : GAP);
      first = false;
      if (count === 0) {
        room -= ROW;
        return 0;
      }
      let n = Math.max(0, Math.floor(room / row));
      if (n < count) n = Math.max(0, Math.floor((room - MORE) / row));
      n = Math.min(n, count);
      room -= n * row + (n < count ? MORE : 0);
      return n;
    };
    const waiting = take(w, ROW, false);
    const running = take(r, ROW, w === 0);
    const finished = room >= HEAD + GAP + DONE ? take(f, DONE, false) : 0;
    return { waiting, running, finished };
  });

  const t3Down = $derived(threads !== null && threads.state !== "ok");
  const DOWN: Record<string, string> = {
    not_running: "T3 Code is closed",
    unreachable: "T3 Code is not answering",
    error: "T3 Code could not be read",
  };
</script>

{#snippet mark(kind: "running" | "background" | "waiting" | "done" | "failed" | "stopped")}
  <svg class="mark {kind}" viewBox="0 0 20 20" aria-hidden="true">
    {#if kind === "running"}
      <circle class="track" cx="10" cy="10" r="7" />
      <path class="arc" d="M10 3a7 7 0 0 1 7 7" />
    {:else if kind === "background"}
      <circle class="track" cx="10" cy="10" r="7" />
      <circle class="orbit" cx="10" cy="3" r="2" />
    {:else if kind === "waiting"}
      <circle class="halo" cx="10" cy="10" r="7.5" />
      <circle class="core" cx="10" cy="10" r="4" />
    {:else if kind === "done"}
      <path d="M4.5 10.5l3.6 3.6L15.5 6.5" />
    {:else if kind === "failed"}
      <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />
    {:else}
      <rect x="6" y="6" width="8" height="8" rx="1.5" />
    {/if}
  </svg>
{/snippet}

{#snippet active(t: T3Thread, waiting: boolean)}
  <li class="row" class:waiting class:background={t.background}>
    {@render mark(waiting ? "waiting" : t.background ? "background" : "running")}
    <span class="text">
      <span class="title">{t.title}</span>
      <span class="sub">{t.project ?? "No project"}{waiting ? " · needs you" : t.background ? " · in background" : ""}</span>
    </span>
    <span class="clock">{span(since(waiting ? t.updated : (t.started ?? t.created)))}</span>
  </li>
{/snippet}

{#snippet done(t: T3Finished)}
  <li class="done {t.outcome}">
    {@render mark(t.outcome)}
    <span class="title">{t.title}</span>
    <span class="when">{ago(since(t.finished))}</span>
  </li>
{/snippet}

{#snippet more(n: number)}
  {#if n > 0}<li class="more">and {n} more</li>{/if}
{/snippet}

<section
  class="board"
  class:stale
  aria-label="T3 Code threads"
  bind:clientHeight={height}
  style:--head="{HEAD}px"
  style:--row="{ROW}px"
  style:--done="{DONE}px"
  style:--more="{MORE}px"
  style:--gap="{GAP}px"
>
  {#if threads === null}
    <p class="quiet">Reading T3 Code</p>
  {:else if t3Down}
    <div class="down">
      <p class="down-title">{DOWN[threads.state]}</p>
      {#if threads.detail && threads.state !== "not_running"}<p class="down-detail">{threads.detail}</p>{/if}
    </div>
  {:else}
    {#if plan.waiting > 0}
      <div class="group">
        <h2 class="wait-head">Waiting on you <span class="n">{threads.waiting.length}</span></h2>
        <ul>
          {#each threads.waiting.slice(0, plan.waiting) as t (t.id)}{@render active(t, true)}{/each}
          {@render more(threads.waiting.length - plan.waiting)}
        </ul>
      </div>
    {/if}
    {#if threads.running.length > 0 && plan.running > 0}
      <div class="group">
        <h2>Running <span class="n">{threads.running.length}</span></h2>
        <ul>
          {#each threads.running.slice(0, plan.running) as t (t.id)}{@render active(t, false)}{/each}
          {@render more(threads.running.length - plan.running)}
        </ul>
      </div>
    {:else if threads.running.length === 0 && threads.waiting.length === 0}
      <div class="group">
        <h2>Running</h2>
        <p class="idle">Nothing running</p>
      </div>
    {/if}
    {#if plan.finished > 0}
      <div class="group">
        <h2>Finished</h2>
        <ul>
          {#each threads.finished.slice(0, plan.finished) as t (t.id)}{@render done(t)}{/each}
        </ul>
      </div>
    {/if}
  {/if}
</section>

<style>
  .board {
    min-height: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    gap: var(--gap);
    transition: opacity 1.5s ease;
  }
  .board.stale {
    opacity: 0.45;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  h2 {
    height: var(--head);
    margin: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 14px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--d-faint);
  }
  h2 .n {
    font-weight: 500;
    color: var(--d-dim);
    letter-spacing: 0;
  }
  h2.wait-head {
    color: var(--d-wait);
  }
  h2.wait-head .n {
    color: var(--d-wait);
  }

  .row {
    height: var(--row);
    display: grid;
    grid-template-columns: 22px minmax(0, 1fr) auto;
    align-items: center;
    column-gap: 14px;
  }
  .text {
    display: flex;
    flex-direction: column;
    min-width: 0;
    line-height: 1.2;
  }
  .row .title {
    font-size: 20px;
    font-weight: 500;
    color: var(--d-ink);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .row .sub {
    font-size: 15px;
    color: var(--d-dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-top: 3px;
  }
  .row.waiting .sub {
    color: color-mix(in srgb, var(--d-wait) 80%, var(--d-dim));
  }
  .clock {
    font-size: 22px;
    font-weight: 500;
    color: var(--d-ink);
    letter-spacing: -0.01em;
  }
  .row.waiting .clock {
    color: var(--d-wait);
  }

  .done {
    height: var(--done);
    display: grid;
    grid-template-columns: 22px minmax(0, 1fr) auto;
    align-items: center;
    column-gap: 14px;
    font-size: 17px;
  }
  .done .title {
    color: var(--d-dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .done.failed .title {
    color: var(--d-ink);
  }
  .when {
    font-size: 15px;
    color: var(--d-faint);
  }
  .more {
    height: var(--more);
    display: flex;
    align-items: center;
    padding-left: 36px;
    font-size: 15px;
    color: var(--d-faint);
  }

  .mark {
    width: 22px;
    height: 22px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .mark.running {
    color: var(--d-calm);
  }
  .mark.running .track {
    opacity: 0.22;
  }
  .mark.running .arc {
    transform-origin: 10px 10px;
    animation: turn 1.8s linear infinite;
  }
  .mark.background {
    color: var(--d-calm);
  }
  .mark.background .track {
    opacity: 0.22;
    stroke-dasharray: 2 3;
  }
  .mark.background .orbit {
    fill: currentColor;
    stroke: none;
    transform-origin: 10px 10px;
    animation: turn 6s linear infinite;
  }
  .row.background .clock {
    color: var(--d-dim);
  }
  .mark.waiting {
    color: var(--d-wait);
  }
  .mark.waiting .core {
    fill: currentColor;
    stroke: none;
  }
  .mark.waiting .halo {
    stroke-width: 1.5;
    transform-origin: 10px 10px;
    animation: call 2.6s ease-out infinite;
  }
  .mark.done {
    color: var(--d-ok);
  }
  .mark.failed {
    color: var(--d-bad);
  }
  .mark.stopped {
    color: var(--d-faint);
  }
  @keyframes turn {
    to {
      transform: rotate(360deg);
    }
  }
  @keyframes call {
    0% {
      transform: scale(0.55);
      opacity: 0.9;
    }
    100% {
      transform: scale(1.2);
      opacity: 0;
    }
  }

  .quiet,
  .idle {
    margin: 0;
    color: var(--d-faint);
    font-size: 20px;
  }
  .idle {
    height: var(--row);
    display: flex;
    align-items: center;
  }
  .down {
    margin: auto 0;
  }
  .down-title {
    margin: 0;
    font-size: 24px;
    font-weight: 600;
    color: var(--d-dim);
  }
  .down-detail {
    margin: 6px 0 0;
    font-size: 15px;
    color: var(--d-faint);
  }

  @media (prefers-reduced-motion: reduce) {
    .mark.running .arc,
    .mark.background .orbit,
    .mark.waiting .halo {
      animation: none;
    }
  }
</style>
