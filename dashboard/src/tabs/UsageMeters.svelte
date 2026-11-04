<script lang="ts">
  import type { Usage } from "../lib/api";
  import { ageOf } from "../lib/time";

  let { usage, now }: { usage: Usage; now: number } = $props();

  type Tone = "ok" | "warn" | "bad";

  // Memory in binary gigabytes, the way Activity Monitor shows it; disks in decimal, the way Finder does.
  function gb(bytes: number, base: number): string {
    const n = bytes / base ** 3;
    const [value, unit] = n >= 1000 ? [n / 1000, "TB"] : [n, "GB"];
    const shown = value >= 100 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, "");
    return `${shown} ${unit}`;
  }

  const meters = $derived.by(() => {
    const out: { name: string; share: number; tone: Tone; text: string }[] = [];
    const m = usage.memory;
    if (m !== null) {
      const tone: Tone = m.pressure === "critical" ? "bad" : m.pressure === "warn" ? "warn" : "ok";
      const pressure = m.pressure === null || m.pressure === "normal" ? "" : `, pressure ${m.pressure}`;
      out.push({ name: "Memory", share: m.used / m.total, tone,
                 text: `${gb(m.used, 1024)} of ${gb(m.total, 1024)}${pressure}` });
    }
    const d = usage.disk;
    if (d !== null) {
      const share = d.used / d.total;
      out.push({ name: "Disk", share, tone: share >= 0.9 ? "bad" : share >= 0.8 ? "warn" : "ok",
                 text: `${gb(d.used, 1000)} of ${gb(d.total, 1000)}` });
    }
    return out;
  });

  const rest = $derived(
    [
      usage.load === null ? null : `load ${usage.load.one.toFixed(1)}${usage.load.cpus ? ` on ${usage.load.cpus} cores` : ""}`,
      usage.booted === null ? null : `up ${ageOf(usage.booted, now).replace(/ ago$/, "")}`,
    ].filter((s) => s !== null),
  );
</script>

<div class="usage">
  {#each meters as meter (meter.name)}
    <div class="meter">
      <span class="name faint small">{meter.name}</span>
      <span
        class="bar"
        role="meter"
        aria-label="{meter.name} used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(meter.share * 100)}
        aria-valuetext={meter.text}
      >
        <span class="fill {meter.tone}" style:width="{Math.min(100, meter.share * 100)}%"></span>
      </span>
      <span class="small">{meter.text}</span>
    </div>
  {/each}
  {#if rest.length > 0}<div class="faint small">{rest.join(" · ")}</div>{/if}
</div>

<style>
  /* One grid for every meter, so the bars line up and share one length. */
  .usage {
    display: grid;
    grid-template-columns: auto minmax(60px, 1fr) auto;
    align-items: center;
    gap: 6px 10px;
    margin-top: 10px;
  }
  .meter {
    display: contents;
  }
  .usage > div:not(.meter) {
    grid-column: 1 / -1;
  }
  .bar {
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
