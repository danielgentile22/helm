<script lang="ts">
  import { untrack } from "svelte";
  import { signIn } from "../lib/auth";
  import Board from "./Board.svelte";
  import { createDesk, STALE_MS } from "./feeds.svelte";
  import Spark from "./Spark.svelte";

  const desk = createDesk();
  // Untracked: the first poll reads the points it is about to replace, and a tracked read
  // would restart every feed on each answer.
  $effect(() => untrack(() => desk.start()));

  let now = $state(Date.now());
  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 1_000);
    return () => clearInterval(timer);
  });

  // The sketchybar thresholds: CPU and GPU amber from 60% and orange from 85%, memory amber
  // from 75% and orange from 90%.
  type Level = "calm" | "amber" | "orange";
  function level(v: number | null, amber: number, orange: number): Level {
    if (v === null) return "calm";
    return v >= orange ? "orange" : v >= amber ? "amber" : "calm";
  }
  const TONE: Record<Level, string> = { calm: "var(--d-calm)", amber: "var(--d-amber)", orange: "var(--d-orange)" };

  type Key = "cpu" | "gpu" | "memory";
  const meters: { key: Key; name: string; amber: number; orange: number }[] = [
    { key: "cpu", name: "CPU", amber: 0.6, orange: 0.85 },
    { key: "gpu", name: "GPU", amber: 0.6, orange: 0.85 },
    { key: "memory", name: "Memory", amber: 0.75, orange: 0.9 },
  ];

  const series = $derived.by(() => {
    const out: Record<Key, { t: number; v: number | null }[]> = { cpu: [], gpu: [], memory: [] };
    for (const p of desk.points) {
      const t = Date.parse(p.at);
      out.cpu.push({ t, v: p.cpu });
      out.gpu.push({ t, v: p.gpu });
      out.memory.push({ t, v: p.memory });
    }
    return out;
  });

  /** The newest value that is not a gap, so one failed probe does not blank the number. */
  function latest(key: Key): number | null {
    const pts = desk.points;
    for (let i = pts.length - 1; i >= Math.max(0, pts.length - 3); i--) {
      const v = pts[i]?.[key];
      if (v !== undefined && v !== null) return v;
    }
    return null;
  }

  const loadedAt = Date.now();
  const stale = $derived(desk.pulseAt === 0 ? now - loadedAt > STALE_MS : now - desk.pulseAt > STALE_MS);

  function ago(ms: number): string {
    const m = Math.round(ms / 60_000);
    if (m < 1) return "a moment";
    if (m < 60) return `${m} min`;
    return `${Math.round(m / 60)} h`;
  }

  // Burn-in: the whole face drifts a few pixels on a slow loop, never resting long on one
  // position, and every static label is drawn in low light.
  const ORBIT: [number, number][] = [
    [0, 0], [3, -2], [5, 1], [2, 4], [-2, 3], [-5, 0], [-3, -3], [1, -5], [4, -4],
  ];
  let step = $state(0);
  $effect(() => {
    const timer = setInterval(() => (step = (step + 1) % ORBIT.length), 75_000);
    return () => clearInterval(timer);
  });
  const drift = $derived.by(() => {
    const [x, y] = ORBIT[step] ?? [0, 0];
    return `translate3d(${x}px, ${y}px, 0)`;
  });

  // A home screen app has no back button, so holding a finger anywhere for a second goes
  // back to helm, and the phone stops reopening the desk on launch.
  const HOLD_MS = 1_000;
  $effect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => clearTimeout(timer);
    const down = () => {
      cancel();
      timer = setTimeout(() => {
        try {
          localStorage.removeItem("helm.desk");
        } catch {
          // Nothing was remembered.
        }
        location.assign("/devices");
      }, HOLD_MS);
    };
    addEventListener("pointerdown", down);
    addEventListener("pointerup", cancel);
    addEventListener("pointercancel", cancel);
    return () => {
      cancel();
      removeEventListener("pointerdown", down);
      removeEventListener("pointerup", cancel);
      removeEventListener("pointercancel", cancel);
    };
  });

  let signingIn = $state(false);
  let signInError = $state<string | null>(null);
  async function startSignIn(): Promise<void> {
    signingIn = true;
    signInError = await signIn();
    signingIn = false;
    if (signInError === null) desk.retry();
  }
</script>

<div class="desk" style:transform={drift}>
  {#if desk.signedOut}
    <div class="gate">
      <p class="gate-title">Signed out</p>
      <p class="gate-text">The desk needs your passkey over the tailnet.</p>
      <button class="gate-btn" onclick={startSignIn} disabled={signingIn}>Sign in with your passkey</button>
      {#if signInError !== null}<p class="gate-error">{signInError}</p>{/if}
    </div>
  {:else}
    <section class="perf" class:stale aria-label="Mac Studio performance">
      {#each meters as m (m.key)}
        {@const v = latest(m.key)}
        {@const tone = TONE[level(v, m.amber, m.orange)]}
        <div class="meter">
          <div class="read">
            <span class="name">{m.name}</span>
            <span class="value" style:color={v === null ? "var(--d-faint)" : tone}>
              {#if v === null}<span class="none">--</span>{:else}{Math.round(v * 100)}<span class="pct">%</span>{/if}
            </span>
          </div>
          <div class="spark"><Spark points={series[m.key]} windowS={desk.windowS} {tone} /></div>
        </div>
      {/each}
    </section>

    <Board threads={desk.threads} {now} stale={desk.threadsAt !== 0 && now - desk.threadsAt > STALE_MS} />

    <aside class="corner" aria-live="polite">
      {#if stale}
        <span class="flag off"><i></i>Mac not answering{desk.pulseAt ? ` · ${ago(now - desk.pulseAt)}` : ""}</span>
      {:else if desk.alerts !== null && desk.alerts > 0}
        <span class="flag bad"><i></i>{desk.alerts} {desk.alerts === 1 ? "alert" : "alerts"}</span>
      {:else if desk.alerts === 0}
        <span class="flag clear">all clear</span>
      {/if}
    </aside>
  {/if}
</div>

<style>
  :global(html.desk-page),
  :global(html.desk-page body) {
    background: #000;
    color-scheme: dark;
    overflow: hidden;
    height: 100%;
    overscroll-behavior: none;
    -webkit-user-select: none;
    user-select: none;
    -webkit-tap-highlight-color: transparent;
    -webkit-touch-callout: none;
  }
  :global(html.desk-page #app) {
    height: 100%;
  }

  .desk {
    /* Pure black: an OLED pixel that is off cannot age. Ink is a warm white held below
       full brightness, and every label sits in low light. */
    --d-ink: #e6e2d9;
    --d-dim: #a7aab0;
    --d-faint: #7b8088;
    --d-calm: #c9ccd2;
    --d-amber: #f0b84c;
    --d-orange: #ff7a3d;
    --d-ok: #74c491;
    --d-bad: #f0695c;
    --d-wait: #f0b84c;
    --pad-t: max(env(safe-area-inset-top), 14px);
    --pad-b: max(env(safe-area-inset-bottom), 10px);
    --pad-l: max(env(safe-area-inset-left), 18px);
    --pad-r: max(env(safe-area-inset-right), 18px);

    position: fixed;
    inset: 0;
    display: grid;
    grid-template-rows: minmax(0, 1fr) minmax(0, 1.08fr);
    padding: var(--pad-t) var(--pad-r) var(--pad-b) var(--pad-l);
    gap: 14px;
    background: #000;
    color: var(--d-ink);
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif;
    font-variant-numeric: tabular-nums;
    transition: transform 40s linear;
    cursor: default;
  }

  @media (orientation: landscape) {
    .desk {
      grid-template-rows: none;
      grid-template-columns: minmax(0, 0.92fr) minmax(0, 1.08fr);
      gap: 28px;
      --pad-t: max(env(safe-area-inset-top), 12px);
      --pad-b: max(env(safe-area-inset-bottom), 12px);
    }
  }

  /* Three meters, each a reading and five minutes of line. */
  .perf {
    display: grid;
    grid-template-rows: repeat(3, minmax(0, 1fr));
    min-height: 0;
    transition: opacity 1.5s ease;
    padding-top: 22px;
  }
  .perf.stale {
    opacity: 0.38;
  }
  .meter {
    display: grid;
    /* The reading is as wide as "100%" and no wider, so the line gets the rest. */
    grid-template-columns: 2.3em minmax(0, 1fr);
    align-items: center;
    column-gap: 20px;
    min-height: 0;
    font-size: clamp(44px, min(14.5vw, 15vh), 76px);
  }
  .meter + .meter {
    border-top: 1px solid #15171b;
  }
  .read {
    display: flex;
    flex-direction: column;
    justify-content: center;
    min-width: 0;
    line-height: 1;
  }
  .name {
    font-size: 15px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--d-faint);
    margin-bottom: 6px;
  }
  .value {
    font-weight: 500;
    letter-spacing: -0.035em;
    transition: color 1.2s ease;
    white-space: nowrap;
  }
  .pct {
    font-size: 0.42em;
    font-weight: 500;
    letter-spacing: 0;
    margin-left: 0.06em;
    opacity: 0.7;
  }
  .none {
    letter-spacing: 0.02em;
  }
  .spark {
    height: 62%;
    min-width: 0;
  }

  @media (orientation: landscape) {
    .perf {
      padding-top: 0;
    }
    .meter {
      font-size: clamp(40px, 15vh, 64px);
    }
    .name {
      font-size: 13px;
      margin-bottom: 4px;
    }
  }

  .corner {
    position: absolute;
    top: calc(var(--pad-t) - 2px);
    right: var(--pad-r);
    font-size: 15px;
    line-height: 20px;
    pointer-events: none;
  }
  @media (orientation: landscape) {
    .corner {
      top: auto;
      bottom: var(--pad-b);
    }
  }
  .flag {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-weight: 600;
  }
  .flag i {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: currentColor;
  }
  .flag.bad {
    color: var(--d-bad);
  }
  .flag.bad i {
    animation: beat 2.4s ease-in-out infinite;
  }
  .flag.off {
    color: var(--d-amber);
  }
  .flag.clear {
    color: var(--d-faint);
    font-weight: 500;
    opacity: 0.7;
  }
  @keyframes beat {
    50% {
      opacity: 0.35;
    }
  }

  .gate {
    grid-row: 1 / -1;
    grid-column: 1 / -1;
    align-self: center;
    justify-self: center;
    max-width: 30ch;
    text-align: center;
  }
  .gate-title {
    font-size: 28px;
    font-weight: 600;
    margin: 0 0 8px;
  }
  .gate-text {
    color: var(--d-dim);
    font-size: 17px;
    margin: 0 0 24px;
  }
  .gate-btn {
    font: inherit;
    font-size: 17px;
    font-weight: 600;
    min-height: 52px;
    padding: 0 22px;
    border-radius: 14px;
    border: 0;
    background: var(--d-amber);
    color: #1a1407;
  }
  .gate-btn:disabled {
    opacity: 0.6;
  }
  .gate-error {
    color: var(--d-bad);
    margin: 16px 0 0;
  }

  @media (prefers-reduced-motion: reduce) {
    .flag.bad i {
      animation: none;
    }
  }
</style>
