<script lang="ts">
  import { fetchJson, type ProjectDetail } from "../lib/api";
  import { createIdeaWrites } from "../lib/ideas.svelte";
  import { layout } from "../lib/layout.svelte";
  import { createPoll } from "../lib/poll.svelte";
  import { ageOf } from "../lib/time";
  import CaptureBox from "../ui/CaptureBox.svelte";
  import LoadState from "../ui/LoadState.svelte";
  import Pill from "../ui/Pill.svelte";
  import Toast from "../ui/Toast.svelte";
  import { trackerLabel } from "./checks";
  import IdeaRow from "./IdeaRow.svelte";
  import InFlight from "./InFlight.svelte";

  let { slug }: { slug: string } = $props();

  // One poll per slug, so switching projects never shows the last one's data.
  const poll = $derived.by(() => {
    const path = `/api/projects/${encodeURIComponent(slug)}`;
    return createPoll(() => fetchJson<ProjectDetail>(path));
  });

  $effect(() => {
    const current = poll;
    current.start();
    return () => current.stop();
  });

  const writes = createIdeaWrites({
    refresh: () => poll.refresh(),
    signedOut: (failure) => poll.signedOut(failure),
  });
</script>

{#snippet detail(project: ProjectDetail, now: number)}
  <div class="row wrap head">
    <h1 class="grow">{project.title}</h1>
    <Pill>{trackerLabel[project.tracker]}</Pill>
    {#if project.pull_requests_scope === "mine"}<Pill>only your pull requests</Pill>{/if}
  </div>
  {#if layout.wide && project.note !== null}
    <div class="capture"><CaptureBox project={project.title} onadd={(draft) => writes.add(draft)} /></div>
  {:else if !layout.wide && project.error !== null}
    <p class="notice">{project.error}</p>
  {/if}

  <h2>Issues</h2>
  {#if project.issues_list.length === 0}
    <p class="empty">No open issues</p>
  {:else}
    <ul class="stack">
      {#each project.issues_list as issue (issue.id)}
        <li class="card row">
          <span class="faint small id">{issue.id}</span>
          <span class="grow">
            {#if issue.url !== null}
              <a class="link" href={issue.url} target="_blank" rel="noopener">{issue.title}</a>
            {:else}
              {issue.title}
            {/if}
          </span>
          <Pill>{issue.status}</Pill>
          {#if issue.updated !== null}<span class="faint small age">{ageOf(issue.updated, now)}</span>{/if}
        </li>
      {/each}
    </ul>
  {/if}

  <h2>Ideas</h2>
  {@const ideas = writes.view(project.ideas, (i) => i.status === "open" && i.project === project.title)}
  {#if ideas.length === 0}
    <p class="empty">No open ideas</p>
  {:else}
    <ul class="stack">
      {#each ideas as idea (idea.id)}
        <IdeaRow {idea} {now} {writes} />
      {/each}
    </ul>
  {/if}
{/snippet}

<LoadState load={poll.load} empty="" isEmpty={() => false} onretry={() => poll.refresh()}>
  {#snippet children(project, now)}
    {#if layout.wide}
      <section class="col" aria-label={project.title}>{@render detail(project, now)}</section>
      <section class="col" aria-label="In flight"><InFlight {project} {now} /></section>
    {:else}
      {@render detail(project, now)}
      <InFlight {project} {now} />
    {/if}
  {/snippet}
</LoadState>

<Toast toast={writes.toast} />

<style>
  .head {
    gap: 8px;
  }
  .capture {
    margin-top: 16px;
  }
  .id {
    flex: none;
    max-width: 40%;
    overflow-wrap: anywhere;
  }
  .grow {
    overflow-wrap: anywhere;
  }
  .age {
    flex: none;
  }
  @media (max-width: 520px) {
    li.row {
      flex-wrap: wrap;
    }
  }
</style>
