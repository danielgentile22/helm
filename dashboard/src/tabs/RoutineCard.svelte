<script lang="ts">
  import type { Routine, RoutineResult } from "../lib/api";
  import { ageOf } from "../lib/time";
  import Dot, { type Tone } from "../ui/Dot.svelte";
  import LogTail from "../ui/LogTail.svelte";
  import Pill from "../ui/Pill.svelte";

  let { routine, now }: { routine: Routine; now: number } = $props();

  const tone: Record<RoutineResult, Tone> = { pass: "pass", fail: "fail", paused: "paused", unknown: "unknown" };
  const said: Record<RoutineResult, string> = {
    pass: "last run passed",
    fail: "last run failed",
    paused: "paused",
    unknown: "no run recorded",
  };
</script>

<li class="card">
  <div class="row">
    <Dot tone={tone[routine.result]} label={said[routine.result]} />
    <span class="grow title">{routine.name}</span>
    {#if routine.result === "paused"}
      <Pill>paused</Pill>
    {:else if routine.result_text !== null}
      <Pill tone={routine.result === "fail" ? "bad" : "plain"}>{routine.result_text}</Pill>
    {/if}
  </div>
  <div class="sub">
    {routine.schedule}
    · {routine.last_run === null ? "never run" : `last run ${ageOf(routine.last_run, now)}`}
    · {routine.paused ? "paused" : routine.next_run === null ? "no next run" : `next ${ageOf(routine.next_run, now)}`}
  </div>
  <div class="sub faint">
    {routine.last_success === null ? "never succeeded" : `last success ${ageOf(routine.last_success, now)}`}
    {#if routine.failures !== null}· {routine.failures} {routine.failures === 1 ? "failure" : "failures"}{/if}
  </div>
  <div class="actions" data-slot="actions"></div>
  <LogTail lines={routine.log_tail} updated={routine.log_updated} {now} open={routine.result === "fail"} />
</li>

<style>
  .actions:empty {
    display: none;
  }
</style>
