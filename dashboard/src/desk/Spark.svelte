<script lang="ts">
  /** One share from 0 to 1 over the desk's window, newest at the right edge. A missing value
   *  or a break longer than three samples (a sleep, a dropped network) is a gap. No axis and
   *  no grid: on a screen that stays on all day, anything that never moves burns in. */
  let { points, windowS, tone }: { points: { t: number; v: number | null }[]; windowS: number; tone: string } =
    $props();

  const W = 300;
  const H = 100;
  const GAP_MS = 6_500;
  const id = `spark-${Math.random().toString(36).slice(2, 8)}`;

  const runs = $derived.by(() => {
    const end = points.at(-1)?.t;
    if (end === undefined) return [];
    const span = windowS * 1000;
    const x = (t: number) => ((t - (end - span)) / span) * W;
    // A hair of headroom so a pinned 100% still shows its line.
    const y = (v: number) => H - Math.min(1, Math.max(0, v)) * (H - 3) - 1.5;
    const out: [number, number][][] = [];
    let run: [number, number][] = [];
    let last = -Infinity;
    for (const p of points) {
      if (p.v === null || p.t - last > GAP_MS) {
        if (run.length > 1) out.push(run);
        run = [];
      }
      if (p.v !== null) run.push([x(p.t), y(p.v)]);
      last = p.t;
    }
    if (run.length > 1) out.push(run);
    return out;
  });

  const line = (run: [number, number][]) => "M" + run.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join("L");
  function area(run: [number, number][]): string {
    const first = run[0]?.[0] ?? 0;
    const last = run.at(-1)?.[0] ?? 0;
    return `${line(run)}L${last.toFixed(1)},${H}L${first.toFixed(1)},${H}Z`;
  }
</script>

<svg viewBox="0 0 {W} {H}" preserveAspectRatio="none" aria-hidden="true" style:--tone={tone}>
  <defs>
    <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" style="stop-color: var(--tone); stop-opacity: 0.2" />
      <stop offset="1" style="stop-color: var(--tone); stop-opacity: 0" />
    </linearGradient>
  </defs>
  {#each runs as run, i (i)}
    <path d={area(run)} fill="url(#{id})" />
    <path class="line" d={line(run)} />
  {/each}
</svg>

<style>
  svg {
    display: block;
    width: 100%;
    height: 100%;
    overflow: visible;
  }
  path {
    transition: fill 1.2s ease;
  }
  .line {
    fill: none;
    stroke: var(--tone);
    stroke-width: 2.25;
    stroke-linejoin: round;
    stroke-linecap: round;
    vector-effect: non-scaling-stroke;
    transition: stroke 1.2s ease;
  }
</style>
