<script lang="ts">
  import { alerts } from "../lib/alerts.svelte";
  import type { Tab } from "../lib/route.svelte";
  import { ageOf } from "../lib/time";
  import Dot from "./Dot.svelte";

  let { tab }: { tab: Tab } = $props();

  const shown = $derived(alerts.now.alerts.filter((a) => a.tab === tab));
  let error = $state<string | null>(null);

  async function dismiss(key: string): Promise<void> {
    error = null;
    const answer = await alerts.dismiss(key);
    if (answer.state === "error") error = answer.detail;
  }
</script>

{#if shown.length > 0 || error !== null}
  <section class="alerts" aria-label="Alerts">
    <ul class="stack">
      {#each shown as alert (alert.key)}
        <li class="card alert">
          <div class="row">
            <Dot tone="fail" label="alert" />
            <div class="grow">
              <div class="title">{alert.title}</div>
              <div class="sub faint">opened {ageOf(alert.opened, Date.now())}</div>
              {#if alert.session?.startsWith("https://")}
                <div class="sub"><a class="link" href={alert.session} target="_blank" rel="noopener">Claude is on it</a></div>
              {:else if alert.session?.startsWith("~") || alert.session?.startsWith("/")}
                <div class="sub faint">Claude ran headless, notes in {alert.session}</div>
              {:else if alert.session}
                <div class="sub faint">Claude is on it in T3</div>
              {/if}
            </div>
            <button class="btn" onclick={() => dismiss(alert.key)}>Dismiss</button>
          </div>
        </li>
      {/each}
    </ul>
    {#if error !== null}<p class="notice" role="alert">{error}</p>{/if}
  </section>
{/if}

<style>
  .alerts {
    margin-bottom: 16px;
  }
  .alert {
    border-color: color-mix(in srgb, var(--bad) 45%, var(--line));
  }
</style>
