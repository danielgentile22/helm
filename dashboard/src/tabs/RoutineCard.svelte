<script lang="ts">
  import { fetchJson, type Failure, type Routine, type RoutineAction, type RoutineResult, type RoutineWrite } from "../lib/api";
  import { launchdLine } from "../lib/jobs";
  import { ageOf } from "../lib/time";
  import Dot, { type Tone } from "../ui/Dot.svelte";
  import Facts from "../ui/Facts.svelte";
  import LogTail from "../ui/LogTail.svelte";
  import Pill from "../ui/Pill.svelte";

  let {
    routine,
    now,
    onchanged,
    onsignedout,
  }: {
    routine: Routine;
    now: number;
    /** Refetch the tab; resolves once the new answer is on screen. */
    onchanged: () => Promise<void>;
    onsignedout: (failure: Failure) => void;
  } = $props();

  const tone: Record<RoutineResult, Tone> = { pass: "pass", fail: "fail", paused: "paused", unknown: "unknown" };
  const said: Record<RoutineResult, string> = {
    pass: "last run passed",
    fail: "last run failed",
    paused: "paused",
    unknown: "no run recorded",
  };
  const doing: Record<RoutineAction, string> = { run: "Starting", pause: "Pausing", resume: "Resuming" };

  let pending = $state<RoutineAction | null>(null);
  let confirming = $state(false);
  let error = $state<string | null>(null);

  async function act(action: RoutineAction): Promise<void> {
    confirming = false;
    pending = action;
    error = null;
    const answer = await fetchJson<RoutineWrite>(`/api/routines/${encodeURIComponent(routine.name)}/${action}`, {});
    if (answer.state === "ready") await onchanged();
    else if (answer.kind === "unauthorized") onsignedout(answer);
    else error = answer.detail;
    pending = null;
  }
</script>

<li class="card">
  <div class="row">
    <Dot tone={tone[routine.result]} label={said[routine.result]} />
    <span class="grow title">{routine.name}</span>
    <Pill>routine</Pill>
    {#if routine.result === "paused"}
      <Pill>paused</Pill>
    {:else if routine.result_text !== null}
      <Pill tone={routine.result === "fail" ? "bad" : "plain"}>{routine.result_text}</Pill>
    {/if}
  </div>
  {#if routine.does !== null}<p class="does">{routine.does}</p>{/if}
  <Facts
    rows={[
      ["Schedule", `${routine.schedule} · ${routine.paused ? "paused" : routine.next_run === null ? "no next run" : `next ${ageOf(routine.next_run, now)}`}`],
      ["Last run", `${routine.last_run === null ? "never run" : ageOf(routine.last_run, now)}${routine.failures !== null ? ` · ${routine.failures} ${routine.failures === 1 ? "failure" : "failures"}` : ""}`],
      ["Last success", routine.last_success === null ? "none recorded yet" : ageOf(routine.last_success, now)],
      ["Model", routine.model === null ? "none, plain code" : `${routine.model}${routine.effort === null ? "" : `, ${routine.effort} effort`}`],
      ["Writes", routine.writes],
      ["Runs", routine.command],
      ["launchd", launchdLine(routine)],
      ["Why", routine.why],
    ]}
  />
  <LogTail lines={routine.log_tail} updated={routine.log_updated} {now} open={routine.result === "fail"}>
    {#snippet actions()}
      <div class="actions" data-slot="actions" aria-busy={pending !== null}>
        {#if pending !== null}
          <button class="btn" disabled>{doing[pending]}</button>
        {:else if confirming}
          <span class="ask">Pause {routine.name} until you resume it?</span>
          <button class="btn primary" onclick={() => act("pause")}>Pause</button>
          <button class="btn" onclick={() => (confirming = false)}>Cancel</button>
        {:else if routine.paused}
          <button class="btn primary" onclick={() => act("resume")}>Resume</button>
        {:else}
          <button class="btn" onclick={() => act("run")} disabled={routine.running}>
            {routine.running ? "Running" : "Run now"}
          </button>
          <button class="btn" onclick={() => (confirming = true)} disabled={routine.running}>Pause</button>
        {/if}
      </div>
      {#if error !== null}<p class="notice failed" role="alert">{error}</p>{/if}
    {/snippet}
  </LogTail>
</li>

<style>
  .actions {
    display: contents;
  }
  .actions .btn {
    min-width: 76px;
  }
  .actions .btn:disabled {
    opacity: 0.55;
    cursor: default;
  }
  .failed {
    flex-basis: 100%;
    order: 1;
    margin: 0;
  }
  .ask {
    flex-basis: 100%;
    font-size: 12px;
    color: var(--dim);
  }
  @media (min-width: 900px) {
    .failed {
    flex-basis: 100%;
    order: 1;
    margin: 0;
  }
  .ask {
      flex-basis: auto;
      margin-right: 4px;
    }
  }
</style>
