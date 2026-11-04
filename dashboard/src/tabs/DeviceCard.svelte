<script lang="ts">
  import type { Device } from "../lib/api";
  import { ageOf, isOverdue, localDate, shortDate } from "../lib/time";
  import Dot from "../ui/Dot.svelte";
  import Pill from "../ui/Pill.svelte";

  let { device, now }: { device: Device; now: number } = $props();

  let open = $state(false);
  const today = $derived(localDate(now));
  const specs = $derived(Object.entries(device.specs ?? {}));
  const warranty = $derived.by(() => {
    if (device.warranty_until === null) return "unknown";
    const date = shortDate(device.warranty_until, today);
    return isOverdue(device.warranty_until, today) ? `expired ${date}` : `until ${date}`;
  });
  const presence = $derived.by(() => {
    if (device.presence === null) return null;
    if (device.presence.online) return "online";
    if (device.presence.last_seen !== null) return `last seen ${ageOf(device.presence.last_seen, now)}`;
    return "offline";
  });
</script>

<li class="card">
  <div class="row top">
    <div class="grow">
      <div class="title">{device.title}</div>
      {#if device.role !== null}<div class="sub">{device.role}</div>{/if}
    </div>
    <div class="row wrap pills">
      {#if device.status !== "in service"}<Pill>{device.status}</Pill>{/if}
      {#if device.t3 === "host"}<Pill tone="accent">T3 host</Pill>{/if}
      {#if device.t3 === "client"}<Pill>T3 client</Pill>{/if}
    </div>
  </div>
  {#if presence !== null}
    <div class="row presence">
      <Dot tone={device.presence?.online ? "pass" : "off"} label={presence} />
      <span class="faint small" aria-hidden="true">{presence}</span>
    </div>
  {/if}
  <button class="btn toggle" aria-expanded={open} onclick={() => (open = !open)}>
    {open ? "Hide details" : "Show details"}
  </button>
  {#if open}
    <table>
      <tbody>
        {#each specs as [key, value] (key)}
          <tr><th scope="row">{key}</th><td>{value}</td></tr>
        {/each}
        <tr><th scope="row">purchased</th><td>{device.purchased === null ? "unknown" : shortDate(device.purchased, today)}</td></tr>
        <tr><th scope="row">warranty</th><td>{warranty}</td></tr>
      </tbody>
    </table>
  {/if}
</li>

<style>
  .top {
    align-items: flex-start;
  }
  .pills {
    gap: 6px;
    justify-content: flex-end;
  }
  .presence {
    gap: 6px;
    margin-top: 6px;
  }
  .toggle {
    margin-top: 8px;
  }
  table {
    width: 100%;
    margin-top: 8px;
    border-collapse: collapse;
    font-size: 12px;
  }
  th,
  td {
    padding: 4px 0;
    vertical-align: top;
    text-align: left;
    overflow-wrap: anywhere;
  }
  th {
    width: 40%;
    color: var(--faint);
    font-weight: 400;
    padding-right: 12px;
  }
</style>
