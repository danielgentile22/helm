<script lang="ts">
  import type { ProjectDetail } from "../lib/api";
  import { ageOf } from "../lib/time";
  import Dot from "../ui/Dot.svelte";
  import Pill from "../ui/Pill.svelte";
  import { checksLabel, checksTone } from "./checks";

  let { project, now }: { project: ProjectDetail; now: number } = $props();
</script>

<h2>Pull requests</h2>
{#if project.pull_requests.length === 0}
  <p class="empty">No open pull requests</p>
{:else}
  <ul class="stack">
    {#each project.pull_requests as pull (`${pull.repo}#${pull.number}`)}
      <li class="card row top">
        <span class="dot"><Dot tone={checksTone[pull.ci]} label={checksLabel[pull.ci]} /></span>
        <div class="grow">
          <a class="link title" href={pull.url} target="_blank" rel="noopener">{pull.title}</a>
          <div class="sub">
            {pull.repo} · {pull.branch}{#if project.pull_requests_scope === "all"} · {pull.author}{/if}
          </div>
        </div>
        {#if pull.draft}<Pill>draft</Pill>{/if}
      </li>
    {/each}
  </ul>
{/if}

<h2>Branches</h2>
{#if project.branches.length === 0}
  <p class="empty">No unmerged branches</p>
{:else}
  <ul class="stack">
    {#each project.branches as branch (`${branch.repo}/${branch.name}`)}
      <li class="card">
        <div class="title">{branch.repo}/{branch.name}</div>
        <div class="sub">{branch.ahead} ahead · {ageOf(branch.at, now)}</div>
      </li>
    {/each}
  </ul>
{/if}

<h2>Last commit</h2>
{#if project.last_commit === null}
  <p class="empty">No commits yet</p>
{:else}
  <div class="card">
    <div class="title">{project.last_commit.subject}</div>
    <div class="sub">{project.last_commit.repo} · {ageOf(project.last_commit.at, now)}</div>
  </div>
{/if}

<style>
  .top {
    align-items: flex-start;
  }
  .dot {
    padding-top: 6px;
  }
</style>
