<script lang="ts">
  import type { Project } from "../lib/api";
  import { follow, href } from "../lib/route.svelte";
  import { ageOf } from "../lib/time";
  import Dot from "../ui/Dot.svelte";
  import Icon from "../ui/Icon.svelte";
  import Pill from "../ui/Pill.svelte";
  import { checksLabel, checksTone, trackerLabel } from "./checks";

  let {
    project,
    now,
    compact = false,
    selected = false,
  }: { project: Project; now: number; compact?: boolean; selected?: boolean } = $props();

  const route = $derived({ tab: "projects", slug: project.slug } as const);
  const firstPull = $derived(project.pull_requests[0]);
</script>

{#snippet name()}
  <span class="name">
    {#if project.pinned}<span class="pin" title="pinned"><Icon name="pin" size={14} /></span>{/if}
    <span class="title">{project.title}</span>
  </span>
{/snippet}

{#if compact}
  <a
    class="compact"
    class:selected
    href={href(route)}
    aria-current={selected ? "page" : undefined}
    onclick={(e) => follow(e, route)}
  >
    {@render name()}
    {#if project.note === null}<Pill>no note</Pill>{/if}
    <span class="faint count" aria-label="open issues">{project.issues?.open ?? ""}</span>
  </a>
{:else}
  <a class="card full" class:pinned={project.pinned} href={href(route)} onclick={(e) => follow(e, route)}>
    <div class="row">
      <div class="grow">{@render name()}</div>
      {#if project.note === null}<Pill>no note</Pill>{/if}
      {#if project.problems.length > 0}
        <Pill tone="warn" title={project.problems.join("\n")}>note has problems</Pill>
      {/if}
    </div>
    <div class="sub">
      {trackerLabel[project.tracker]}
      {#if project.pull_requests_scope === "mine"}<span> · only your pull requests</span>{/if}
      <span> · {project.last_commit === null ? "no commits" : `last commit ${ageOf(project.last_commit.at, now)}`}</span>
    </div>
    <div class="stats row wrap">
      {#if project.issues !== null}
        <span><b>{project.issues.open}</b> open issues</span>
      {:else if project.tracker === "github"}
        <span class="faint">issues unknown</span>
      {/if}
      <span><b>{project.pull_requests.length}</b> pull requests</span>
      <span><b>{project.branches.length}</b> branches</span>
      {#if project.ideas_open > 0}
        <Pill tone="accent">{project.ideas_open} open {project.ideas_open === 1 ? "idea" : "ideas"}</Pill>
      {:else}
        <span><b>0</b> open ideas</span>
      {/if}
    </div>
    {#if project.tracker === "scratch" && project.issues !== null && project.issues.open > 0}
      <div class="row wrap statuses">
        {#each Object.entries(project.issues.by_status) as [status, count] (status)}
          <Pill>{count} {status}</Pill>
        {/each}
      </div>
    {/if}
    {#if firstPull !== undefined}
      <div class="row pull">
        <Dot tone={checksTone[firstPull.ci]} label={checksLabel[firstPull.ci]} />
        <span class="grow muted small ellipsis">{firstPull.title}</span>
      </div>
    {/if}
  </a>
{/if}

<style>
  a {
    display: block;
    text-decoration: none;
    color: inherit;
    transition: border-color 120ms, background-color 120ms;
  }
  .full:hover {
    border-color: var(--faint);
  }
  .pinned {
    border-color: var(--accent-line);
    background: linear-gradient(180deg, var(--accent-wash), var(--surface));
  }
  .name {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .pin {
    color: var(--accent);
    display: inline-flex;
  }
  .stats {
    gap: 14px;
    margin-top: 8px;
    font-size: 12px;
    color: var(--dim);
  }
  .stats b {
    color: var(--ink);
    font-weight: 600;
  }
  .statuses {
    gap: 6px;
    margin-top: 8px;
  }
  .pull {
    margin-top: 8px;
  }
  .ellipsis {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .compact {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-height: 36px;
    padding: 8px 10px;
    border-radius: 8px;
  }
  .compact .title {
    font-weight: 400;
  }
  .compact:hover {
    background: var(--surface);
  }
  .compact.selected {
    background: var(--surface-2);
  }
  .compact.selected .title {
    font-weight: 600;
  }
  .count {
    font-variant-numeric: tabular-nums;
  }
</style>
