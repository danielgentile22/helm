<script lang="ts">
  import { fetchJson, type Project, type ProjectsResponse } from "../lib/api";
  import { layout } from "../lib/layout.svelte";
  import { createPoll } from "../lib/poll.svelte";
  import { follow, href } from "../lib/route.svelte";
  import { ageOf } from "../lib/time";
  import Icon from "../ui/Icon.svelte";
  import LoadState from "../ui/LoadState.svelte";
  import ProjectCard from "./ProjectCard.svelte";
  import ProjectDetail from "./ProjectDetail.svelte";

  let { slug, at = $bindable() }: { slug: string | null; at: number | null } = $props();

  const poll = createPoll(
    () => fetchJson<ProjectsResponse>("/api/projects"),
    (d) => d.refreshing,
  );

  // Reread every project's issues, pull requests and branches now instead of at the next
  // capture. The answers say `refreshing` until it is merged, and the poll follows that.
  let asking = $state(false);
  let refreshError = $state<string | null>(null);
  async function refreshNow(): Promise<void> {
    asking = true;
    refreshError = null;
    const answer = await fetchJson<{ refreshing: boolean }>("/api/projects/refresh", {});
    if (answer.state === "ready") await poll.refresh();
    else if (answer.kind === "unauthorized") poll.signedOut(answer);
    else refreshError = answer.detail;
    asking = false;
  }
  $effect(() => {
    poll.start();
    return () => poll.stop();
  });
  $effect(() => {
    at = poll.load.state === "ready" ? poll.load.at : null;
  });

  const back = { tab: "projects", slug: null } as const;

  // Nothing open: no issues, pull requests, unmerged branches or open ideas. Pinned
  // projects always stay in the main list.
  function quiet(project: Project): boolean {
    return (
      !project.pinned &&
      (project.issues?.open ?? 0) === 0 &&
      project.pull_requests.length === 0 &&
      project.branches.length === 0 &&
      project.ideas_open === 0
    );
  }

  function split(projects: Project[]): { active: Project[]; idle: Project[] } {
    return {
      active: projects.filter((p) => !quiet(p)),
      idle: projects.filter(quiet),
    };
  }
</script>

{#snippet captured(data: ProjectsResponse, now: number)}
  <p class="faint small captured">
    {#if asking || data.refreshing}
      <span aria-live="polite">refreshing</span>
    {:else}
      captured {ageOf(data.produced, now)} ·
      <button class="refresh" onclick={refreshNow}>Refresh</button>
    {/if}
  </p>
  {#if refreshError !== null}<p class="notice">{refreshError}</p>{/if}
  {#if data.error !== null}<p class="notice">{data.error}</p>{/if}
{/snippet}

{#if !layout.wide && slug !== null}
  <div class="pushed">
    <a class="back" href={href(back)} onclick={(e) => follow(e, back)}>
      <Icon name="chevron" size={18} />Projects
    </a>
    <ProjectDetail {slug} />
  </div>
{:else}
  <LoadState
    load={poll.load}
    empty="No projects yet. Capture has not written any."
    isEmpty={(d) => d.projects.length === 0 && d.error === null}
    onretry={() => poll.refresh()}
  >
    {#snippet children(data, now)}
      {#if layout.wide}
        {@const selected = slug ?? data.projects[0]?.slug ?? null}
        {@const groups = split(data.projects)}
        <div class="workspace">
          <section class="col list" aria-label="Projects">
            {@render captured(data, now)}
            <ul class="stack">
              {#each groups.active as project (project.slug)}
                <li><ProjectCard {project} {now} compact selected={project.slug === selected} /></li>
              {/each}
            </ul>
            {#if groups.idle.length > 0}
              <details class="idle" open={groups.idle.some((p) => p.slug === selected)}>
                <summary><Icon name="chevron" size={14} />{groups.idle.length} with nothing open</summary>
                <ul class="stack">
                  {#each groups.idle as project (project.slug)}
                    <li><ProjectCard {project} {now} compact selected={project.slug === selected} /></li>
                  {/each}
                </ul>
              </details>
            {/if}
          </section>
          {#if selected !== null}
            <ProjectDetail slug={selected} />
          {:else}
            <section class="col"><p class="empty">No projects yet</p></section>
          {/if}
        </div>
      {:else}
        {@const groups = split(data.projects)}
        {@render captured(data, now)}
        <ul class="stack cards">
          {#each groups.active as project (project.slug)}
            <li><ProjectCard {project} {now} /></li>
          {/each}
        </ul>
        {#if groups.idle.length > 0}
          <details class="idle">
            <summary><Icon name="chevron" size={14} />{groups.idle.length} with nothing open</summary>
            <ul class="stack cards">
              {#each groups.idle as project (project.slug)}
                <li><ProjectCard {project} {now} /></li>
              {/each}
            </ul>
          </details>
        {/if}
      {/if}
    {/snippet}
  </LoadState>
{/if}

<style>
  .captured {
    margin: 0;
  }
  .refresh {
    padding: 0;
    border: 0;
    background: none;
    color: var(--accent);
    font: inherit;
    cursor: pointer;
  }
  .refresh:hover {
    text-decoration: underline;
  }
  .cards {
    margin-top: 12px;
  }
  .workspace {
    display: grid;
    grid-template-columns: 280px minmax(0, 1fr) 340px;
    height: calc(100dvh - var(--header));
  }
  .workspace > :global(*) {
    min-width: 0;
  }
  .workspace :global(.col) {
    overflow-y: auto;
    padding: 16px 20px 32px;
    border-right: 1px solid var(--line);
  }
  .workspace :global(.col:last-child) {
    border-right: 0;
  }
  .workspace :global(.col > h2:first-child) {
    margin-top: 0;
  }
  .workspace > :global(.skeleton),
  .workspace > :global(.card),
  .workspace > :global(.empty) {
    margin: 16px 20px;
  }
  .workspace .list {
    padding: 16px 10px 32px;
  }
  .list .captured,
  .list .notice {
    padding: 0 10px 8px;
  }
  .list .stack > * + * {
    margin-top: 2px;
  }
  .idle {
    margin-top: 16px;
  }
  .idle summary {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 44px;
    padding: 0 10px;
    color: var(--faint);
    cursor: pointer;
    list-style: none;
    user-select: none;
  }
  .idle summary::-webkit-details-marker {
    display: none;
  }
  .idle summary :global(svg) {
    transform: rotate(180deg);
    transition: transform 120ms ease-out;
  }
  .idle[open] summary :global(svg) {
    transform: rotate(270deg);
  }
  .back {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    min-height: 44px;
    margin-left: -6px;
    color: var(--accent);
    text-decoration: none;
  }
  .pushed {
    animation: push 160ms ease-out;
  }
  @keyframes push {
    from {
      transform: translateX(24px);
      opacity: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .pushed {
      animation: none;
    }
  }
</style>
