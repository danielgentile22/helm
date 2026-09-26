<script lang="ts">
  import { fly } from "svelte/transition";
  import type { HelmClient } from "./api";
  import { HttpError } from "./api";
  import { layout } from "./layout.svelte";
  import { screenIn } from "./motion";
  import { router } from "./route.svelte";
  import Enroll from "./screens/Enroll.svelte";
  import ErrorScreen from "./screens/ErrorScreen.svelte";
  import List from "./screens/List.svelte";
  import Login from "./screens/Login.svelte";
  import SettingsScreen from "./screens/Settings.svelte";
  import Thread from "./screens/Thread.svelte";
  import { settings } from "./settings.svelte";

  let { api }: { api: HelmClient } = $props();

  let me = $state<{ label: string } | null>(null);
  let unauthorized = $state(false);
  let failure = $state<unknown>(null);
  let checking = false;

  $effect(() => {
    const route = router.route;
    if (route.name === "enroll") return;
    if (me) {
      if (route.name === "login") router.navigate("/");
      return;
    }
    if (checking) return;
    checking = true;
    void (async () => {
      try {
        me = await api.me();
        unauthorized = false;
      } catch (err) {
        if (err instanceof HttpError && (err.status === 401 || err.status === 403)) unauthorized = true;
        else failure = err;
      } finally {
        checking = false;
      }
    })();
  });

  $effect(() => {
    if (me) void settings.load(api).catch(() => null);
  });

  $effect(() => {
    const theme = settings.value?.theme;
    if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
  });

  const signedIn = (who: { label: string }): void => {
    me = who;
    unauthorized = false;
    router.navigate("/");
  };
</script>

{#if router.route.name === "enroll"}
  <Enroll {api} token={router.route.token} />
{:else if failure}
  <ErrorScreen error={failure} />
{:else if unauthorized}
  <Login {api} onSignedIn={signedIn} />
{:else if me}
  {@const route = router.route}
  {#if layout.mode === "split"}
    <div class="panes">
      <aside class="pane-list"><List {api} /></aside>
      <section class="pane-main">
        {#key route.name === "thread" ? `thread:${route.threadId}` : route.name}
          <div class="arrives" in:fly|global={screenIn}>
            {#if route.name === "thread"}
              <Thread {api} threadId={route.threadId} />
            {:else if route.name === "settings"}
              <SettingsScreen {api} />
            {:else}
              <p class="muted center pane-empty">Pick a thread</p>
            {/if}
          </div>
        {/key}
      </section>
    </div>
  {:else}
    {#key route.name === "thread" ? `thread:${route.threadId}` : route.name}
      <div class="arrives" in:fly|global={screenIn}>
        {#if route.name === "thread"}
          <Thread {api} threadId={route.threadId} />
        {:else if route.name === "settings"}
          <SettingsScreen {api} />
        {:else if route.name === "list"}
          <List {api} />
        {/if}
      </div>
    {/key}
  {/if}
{:else}
  <main class="screen"><p class="muted center">Loading Helm</p></main>
{/if}
