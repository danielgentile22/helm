<script lang="ts">
  import type { Usage } from "../lib/api";
  import { ageOf } from "../lib/time";
  import HourChart from "./HourChart.svelte";

  let { usage, now }: { usage: Usage; now: number } = $props();

  type Tone = "ok" | "warn" | "bad";

  // Memory in binary gigabytes, the way Activity Monitor shows it; disks in decimal, the way Finder does.
  function gb(bytes: number, base: number): string {
    const n = bytes / base ** 3;
    const [value, unit] = n >= 1000 ? [n / 1000, "TB"] : [n, "GB"];
    const shown = value >= 100 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, "");
    return `${shown} ${unit}`;
  }

  const history = $derived(usage.history.map((p) => ({ ...p, t: Date.parse(p.at) })));
  // The graph needs two points to draw a line; until then it says it is collecting.
  const collecting = $derived(history.length < 2);

  const cpu = $derived.by(() => {
    const points = history.map((p) => ({ t: p.t, v: p.cpu }));
    const latest = [...points].reverse().find((p) => p.v !== null)?.v ?? null;
    const tone: Tone = latest !== null && latest >= 0.9 ? "bad" : latest !== null && latest >= 0.7 ? "warn" : "ok";
    return { points, tone, text: latest === null ? "measuring" : `${Math.round(latest * 100)}%` };
  });

  const memory = $derived.by(() => {
    const m = usage.memory;
    if (m === null) return null;
    const tone: Tone = m.pressure === "critical" ? "bad" : m.pressure === "warn" ? "warn" : "ok";
    const pressure = m.pressure === null || m.pressure === "normal" ? "" : `, pressure ${m.pressure}`;
    return {
      points: history.map((p) => ({ t: p.t, v: p.memory === null ? null : p.memory / m.total })),
      tone,
      text: `${gb(m.used, 1024)} of ${gb(m.total, 1024)}${pressure}`,
    };
  });

  const disk = $derived.by(() => {
    const d = usage.disk;
    if (d === null) return null;
    const share = d.used / d.total;
    const tone: Tone = share >= 0.9 ? "bad" : share >= 0.8 ? "warn" : "ok";
    return { share, tone, text: `${gb(d.used, 1000)} of ${gb(d.total, 1000)}` };
  });

  const rest = $derived(
    [
      usage.load === null ? null : `load ${usage.load.one.toFixed(1)}${usage.load.cpus ? ` on ${usage.load.cpus} cores` : ""}`,
      usage.booted === null ? null : `up ${ageOf(usage.booted, now).replace(/ ago$/, "")}`,
    ].filter((s) => s !== null),
  );
</script>

<div class="usage">
  <div class="block">
    <div class="head"><span class="faint small">CPU</span><span class="small">{cpu.text}</span></div>
    {#if collecting}
      <div class="collecting faint small">Collecting the first samples. The graph fills in over the next hour.</div>
    {:else}
      <HourChart points={cpu.points} tone={cpu.tone} label="CPU use over the last hour, now {cpu.text}" />
    {/if}
  </div>
  {#if memory !== null}
    <div class="block">
      <div class="head"><span class="faint small">Memory</span><span class="small">{memory.text}</span></div>
      {#if !collecting}
        <HourChart points={memory.points} tone={memory.tone} label="Memory use over the last hour, now {memory.text}" />
      {/if}
    </div>
  {/if}
  {#if !collecting}
    <div class="axis faint" aria-hidden="true"><span>1 hour ago</span><span>now</span></div>
  {/if}
  {#if disk !== null}
    <div class="block">
      <div class="head"><span class="faint small">Disk</span><span class="small">{disk.text}</span></div>
      <span
        class="bar"
        role="meter"
        aria-label="Disk used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(disk.share * 100)}
        aria-valuetext={disk.text}
      >
        <span class="fill {disk.tone}" style:width="{Math.min(100, disk.share * 100)}%"></span>
      </span>
    </div>
  {/if}
  {#if rest.length > 0}<div class="faint small">{rest.join(" · ")}</div>{/if}
</div>

<style>
  .usage {
    display: grid;
    gap: 10px;
    margin-top: 10px;
  }
  .block {
    display: grid;
    gap: 4px;
  }
  .head {
    display: flex;
    justify-content: space-between;
    gap: 10px;
  }
  .collecting {
    padding: 8px 0;
  }
  .axis {
    display: flex;
    justify-content: space-between;
    margin-top: -6px;
    font-size: 11px;
  }
  .bar {
    display: block;
    height: 6px;
    border-radius: 3px;
    background: var(--off);
    overflow: hidden;
  }
  .fill {
    display: block;
    height: 100%;
    border-radius: 3px;
  }
  .ok {
    background: var(--ok);
  }
  .warn {
    background: var(--warn);
  }
  .bad {
    background: var(--bad);
  }
</style>
