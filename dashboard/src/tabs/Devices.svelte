<script lang="ts">
  import { fetchJson, type Device, type DevicesResponse } from "../lib/api";
  import { createPoll } from "../lib/poll.svelte";
  import LoadState from "../ui/LoadState.svelte";
  import DeviceCard from "./DeviceCard.svelte";

  let { at = $bindable() }: { at: number | null } = $props();

  const poll = createPoll(() => fetchJson<DevicesResponse>("/api/devices"));
  $effect(() => {
    poll.start();
    return () => poll.stop();
  });
  $effect(() => {
    at = poll.load.state === "ready" ? poll.load.at : null;
  });

  const groups: [string, string][] = [
    ["desktop", "Desktops"],
    ["laptop", "Laptops"],
    ["phone", "Phones"],
    ["tablet", "Tablets"],
    ["watch", "Watches"],
    ["display", "Displays"],
    ["dock", "Docks"],
    ["storage", "Storage"],
    ["network", "Network"],
    ["audio", "Audio"],
    ["camera", "Cameras"],
    ["home", "Home"],
  ];

  // A kind outside the set (the server keeps it as written) lands in Other, so no note goes missing.
  function grouped(devices: Device[]): { heading: string; devices: Device[] }[] {
    const known = new Set(groups.map(([kind]) => kind));
    const out = groups.map(([kind, heading]) => ({ heading, devices: devices.filter((d) => d.kind === kind) }));
    out.push({ heading: "Other", devices: devices.filter((d) => !known.has(d.kind)) });
    return out.filter((g) => g.devices.length > 0);
  }
</script>

<LoadState
  load={poll.load}
  empty="No device notes in the vault yet."
  isEmpty={(d) => d.devices.length === 0 && d.tailnet_error === null}
  onretry={() => poll.refresh()}
>
  {#snippet children(data, now)}
    {#if data.tailnet_error !== null}
      <p class="notice tailnet">Online status is unavailable: {data.tailnet_error}</p>
    {/if}
    <div class="groups">
      {#each grouped(data.devices) as group (group.heading)}
        <section aria-label={group.heading}>
          <h2>{group.heading}</h2>
          <ul class="stack">
            {#each group.devices as device (device.slug)}
              <DeviceCard {device} {now} />
            {/each}
          </ul>
        </section>
      {/each}
    </div>
  {/snippet}
</LoadState>

<style>
  .tailnet {
    margin: 0 0 16px;
  }
  .groups > section:first-child h2 {
    margin-top: 0;
  }
  @media (min-width: 1100px) {
    .groups {
      display: grid;
      grid-template-columns: 1fr 1fr;
      column-gap: 24px;
      align-items: start;
    }
    .groups > section:nth-child(2) h2 {
      margin-top: 0;
    }
  }
</style>
