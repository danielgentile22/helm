<script lang="ts">
  import type { Idea } from "../lib/api";
  import { daysAgo, dueLabel, localDate } from "../lib/time";

  let { idea, now }: { idea: Idea; now: number } = $props();

  const today = $derived(localDate(now));
  const issueIsLink = $derived(idea.issue !== null && /^https?:\/\//.test(idea.issue));
</script>

<li class="card">
  <div class="text">{idea.title}</div>
  <div class="sub">
    {idea.project ?? idea.department}
    {#if idea.due !== null}
      · <span class:warn-text={idea.due <= today}>{dueLabel(idea.due, today)}</span>
    {/if}
    · {daysAgo(idea.created, today)}
  </div>
  {#if idea.issue !== null}
    <div class="sub">
      {#if issueIsLink}
        <a class="link issue" href={idea.issue} target="_blank" rel="noopener">Open the issue</a>
      {:else}
        issue at {idea.issue}
      {/if}
    </div>
  {/if}
</li>

<style>
  .text {
    overflow-wrap: anywhere;
  }
  .issue {
    color: var(--accent);
  }
</style>
