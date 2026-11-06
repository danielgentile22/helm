<script lang="ts">
  import { fetchJson, type BackgroundResponse, type Service } from "../lib/api";
  import { createPoll } from "../lib/poll.svelte";
  import { byProject, launchdLine } from "../lib/jobs";
  import Dot from "../ui/Dot.svelte";
  import Facts from "../ui/Facts.svelte";
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
    {#each byProject(data.routines, data.services) as group, i (group.project)}
      <h2 class:first={i === 0}>{group.project === "" ? "Not in models.json" : group.project}</h2>
      <ul class="stack">
        {#each group.routines as routine (routine.name)}
          <RoutineCard
            {routine}
            {now}
            onchanged={() => poll.refresh()}
            onsignedout={(failure) => poll.signedOut(failure)}
          />
        {/each}
        {#each group.services as service (service.label)}
          {@const s = state(service)}
          <li class="card">
            <div class="row">
              <Dot tone={s.tone} label={s.label} />
              <span class="grow title">{service.name}</span>
              <Pill>service</Pill>
              {#if service.last_exit !== null && service.last_exit !== 0}
                <Pill tone="warn">last exit {service.last_exit}</Pill>
              {/if}
            </div>
            {#if service.does !== null}<p class="does">{service.does}</p>{/if}
            <Facts
              rows={[
                ["State", s.label],
                ["Lifecycle", service.listed ? "starts at login, restarted if it exits" : "installed outside helm, so models.json does not describe it"],
                ["Writes", service.writes],
                ["Runs", service.command],
                ["launchd", launchdLine(service)],
                ["Why", service.why],
              ]}
            />
            <LogTail lines={service.log_tail} updated={service.log_updated} {now} />
          </li>
        {/each}
      </ul>
    {/each}
  {/snippet}
</LoadState>

<style>
  .first {
    margin-top: 0;
  }
</style>
