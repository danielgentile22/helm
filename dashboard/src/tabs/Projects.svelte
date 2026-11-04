<script lang="ts">
  import { fetchJson, type ProjectsResponse } from "../lib/api";
  import { layout } from "../lib/layout.svelte";
  import { createPoll } from "../lib/poll.svelte";
  import { follow, href } from "../lib/route.svelte";
  import { ageOf } from "../lib/time";
  import Icon from "../ui/Icon.svelte";
  import LoadState from "../ui/LoadState.svelte";
  import ProjectCard from "./ProjectCard.svelte";
  import ProjectDetail from "./ProjectDetail.svelte";

  let { slug, at = $bindable() }: { slug: string | null; at: number | null } = $props();

  const poll = createPoll(() => fetchJson<ProjectsResponse>("/api/projects"));
  $effect(() => {
    poll.start();
    return () => poll.stop();
  });
  $effect(() => {
    at = poll.load.state === "ready" ? poll.load.at : null;
  });

  const back = { tab: "projects", slug: null } as const;
</script>

{#snippet captured(data: ProjectsResponse, now: number)}
  <p class="faint small captured">captured {ageOf(data.produced, now)}</p>
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
        <div class="workspace">
          <section class="col list" aria-label="Projects">
            {@render captured(data, now)}
            <ul class="stack">
              {#each data.projects as project (project.slug)}
                <li><ProjectCard {project} {now} compact selected={project.slug === selected} /></li>
              {/each}
            </ul>
          </section>
          {#if selected !== null}
            <ProjectDetail slug={selected} />
          {:else}
            <section class="col"><p class="empty">No projects yet</p></section>
          {/if}
        </div>
      {:else}
        {@render captured(data, now)}
        <ul class="stack cards">
          {#each data.projects as project (project.slug)}
            <li><ProjectCard {project} {now} /></li>
          {/each}
        </ul>
      {/if}
    {/snippet}
  </LoadState>
{/if}

<style>
  .captured {
    margin: 0;
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
