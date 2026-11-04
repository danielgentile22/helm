<script lang="ts">
  import { fetchJson, type BackgroundResponse, type Service } from "../lib/api";
  import { createPoll } from "../lib/poll.svelte";
  import Dot from "../ui/Dot.svelte";
  import LoadState from "../ui/LoadState.svelte";
  import LogTail from "../ui/LogTail.svelte";
  import Pill from "../ui/Pill.svelte";
  import RoutineCard from "./RoutineCard.svelte";

  let { at = $bindable() }: { at: number | null } = $props();

  const poll = createPoll(() => fetchJson<BackgroundResponse>("/api/background"));
  $effect(() => {
    poll.start();
    return () => poll.stop();
  });
  $effect(() => {
    at = poll.load.state === "ready" ? poll.load.at : null;
  });

  function state(service: Service): { tone: "pass" | "pending" | "off"; label: string } {
    if (service.running) return { tone: "pass", label: "running" };
    if (service.loaded) return { tone: "pending", label: "loaded but not running" };
    return { tone: "off", label: "not loaded" };
  }
</script>

<LoadState
  load={poll.load}
  empty="No routines or services are set up."
  isEmpty={(d) => d.routines.length === 0 && d.services.length === 0}
  onretry={() => poll.refresh()}
>
  {#snippet children(data, now)}
    <h2 class="first">Routines</h2>
    {#if data.routines.length === 0}
      <p class="empty">No routines in models.json</p>
    {:else}
      <ul class="stack">
        {#each data.routines as routine (routine.name)}
          <RoutineCard {routine} {now} />
        {/each}
      </ul>
    {/if}

    <h2>Services</h2>
    {#if data.services.length === 0}
      <p class="empty">No services</p>
    {:else}
      <ul class="stack">
        {#each data.services as service (service.label)}
          {@const s = state(service)}
          <li class="card">
            <div class="row">
              <Dot tone={s.tone} label={s.label} />
              <span class="grow title">{service.name}</span>
              {#if !service.listed}<Pill>not in models.json</Pill>{/if}
              {#if service.last_exit !== null && service.last_exit !== 0}
                <Pill tone="warn">last exit {service.last_exit}</Pill>
              {/if}
            </div>
            <div class="sub">{s.label}{#if service.why !== null} · {service.why}{/if}</div>
            <LogTail lines={service.log_tail} updated={service.log_updated} {now} />
          </li>
        {/each}
      </ul>
    {/if}
  {/snippet}
</LoadState>

<style>
  .first {
    margin-top: 0;
  }
</style>
