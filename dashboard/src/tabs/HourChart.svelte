<script lang="ts">
  /** One value from 0 to 1 over the last hour, drawn as a filled line. A missing value or a
   *  break longer than three samples (a restart, a sleep) is a gap, never a straight join. */
  let { points, label, tone }: { points: { t: number; v: number | null }[]; label: string; tone: "ok" | "warn" | "bad" } =
    $props();

  const W = 360;
  const H = 40;
  const HOUR = 3_600_000;
  const GAP = 35_000;

  const segments = $derived.by(() => {
    const newest = points.at(-1);
    if (newest === undefined) return [];
    const end = newest.t;
    const x = (t: number) => ((t - (end - HOUR)) / HOUR) * W;
    const y = (v: number) => H - Math.min(1, Math.max(0, v)) * H;
    const out: [number, number][][] = [];
    let run: [number, number][] = [];
    let last = -Infinity;
    for (const p of points) {
      if (p.t < end - HOUR) continue;
      if (p.v === null || p.t - last > GAP) {
        if (run.length > 0) out.push(run);
        run = [];
      }
      if (p.v !== null) run.push([x(p.t), y(p.v)]);
      last = p.t;
    }
    if (run.length > 0) out.push(run);
    return out;
  });

  const xy = (run: [number, number][]) => run.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" L");

  function area(run: [number, number][]): string {
    const first = run[0]?.[0] ?? 0;
    const last = run.at(-1)?.[0] ?? 0;
    return `M${first.toFixed(1)},${H} L${xy(run)} L${last.toFixed(1)},${H} Z`;
  }
</script>

<svg class={tone} viewBox="0 0 {W} {H}" preserveAspectRatio="none" role="img" aria-label={label}>
  <line class="mid" x1="0" x2={W} y1={H / 2} y2={H / 2} />
  {#each segments as run, i (i)}
    <path class="area" d={area(run)} />
    <path class="line" d="M{xy(run)}" />
  {/each}
</svg>

<style>
  svg {
    display: block;
    width: 100%;
    height: 40px;
    border-radius: 4px;
    background: var(--surface-2);
  }
  .mid {
    stroke: var(--line);
    stroke-width: 1;
    stroke-dasharray: 3 3;
    vector-effect: non-scaling-stroke;
  }
  .line {
    fill: none;
    stroke-width: 1.5;
    stroke-linejoin: round;
    vector-effect: non-scaling-stroke;
  }
  .area {
    opacity: 0.18;
  }
  .ok .line {
    stroke: var(--ok);
  }
  .ok .area {
    fill: var(--ok);
  }
  .warn .line {
    stroke: var(--warn);
  }
  .warn .area {
    fill: var(--warn);
  }
  .bad .line {
    stroke: var(--bad);
  }
  .bad .area {
    fill: var(--bad);
  }
</style>
