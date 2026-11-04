<script lang="ts">
  import "./app.css";
  import { layout } from "./lib/layout.svelte";
  import { follow, href, router, type Route, type Tab } from "./lib/route.svelte";
  import { ageOf } from "./lib/time";
  import Background from "./tabs/Background.svelte";
  import Devices from "./tabs/Devices.svelte";
  import Ideas from "./tabs/Ideas.svelte";
  import Projects from "./tabs/Projects.svelte";
  import Badge from "./ui/Badge.svelte";
  import Icon from "./ui/Icon.svelte";

  const tabs: { tab: Tab; label: string }[] = [
    { tab: "projects", label: "Projects" },
    { tab: "ideas", label: "Ideas" },
    { tab: "background", label: "Background" },
    { tab: "devices", label: "Devices" },
  ];

  function routeOf(tab: Tab): Route {
    return tab === "projects" ? { tab, slug: null } : { tab };
  }

  const current = $derived(router.current);
  const label = $derived(tabs.find((t) => t.tab === current.tab)?.label ?? "");
  const workspace = $derived(current.tab === "projects" && layout.wide);

  // When the active tab last heard from helm.
  let at = $state<number | null>(null);
  let now = $state(Date.now());
  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(timer);
  });
  const updated = $derived(at === null ? null : `updated ${ageOf(new Date(at).toISOString(), Math.max(now, at))}`);

  $effect(() => {
    document.title = `${label} · helm`;
  });
</script>

{#snippet tabLinks()}
  <nav aria-label="Tabs" class={layout.wide ? "rail" : "bar"}>
    {#each tabs as t (t.tab)}
      {@const route = routeOf(t.tab)}
      <a
        href={href(route)}
        aria-current={current.tab === t.tab ? "page" : undefined}
        onclick={(e) => follow(e, route)}
      >
        <Icon name={t.tab} />
        <span class="label">{t.label}<Badge count={0} label="alerts" /></span>
      </a>
    {/each}
  </nav>
{/snippet}

<header class={layout.wide ? "wide" : "narrow"}>
  {#if layout.wide}
    <span class="wordmark">helm</span>
    {@render tabLinks()}
  {:else}
    <h1>{label}</h1>
  {/if}
  <span class="meta">
    {#if updated !== null}<span class="faint small">{updated}</span>{/if}
    <Badge count={0} label="alerts" />
  </span>
</header>

<main class:workspace>
  {#if current.tab === "projects"}
    <Projects slug={current.slug} bind:at />
  {:else if current.tab === "ideas"}
    <Ideas bind:at />
  {:else if current.tab === "background"}
    <Background bind:at />
  {:else}
    <Devices bind:at />
  {/if}
</main>

{#if !layout.wide}{@render tabLinks()}{/if}

<style>
  header {
    display: flex;
    align-items: center;
    gap: 16px;
    min-width: 0;
  }
  header.narrow {
    padding: calc(env(safe-area-inset-top) + 14px) 16px 4px;
  }
  header.wide {
    position: sticky;
    top: 0;
    z-index: 5;
    height: var(--header);
    padding: 0 20px;
    background: var(--bg);
    border-bottom: 1px solid var(--line);
  }
  header h1 {
    flex: 1;
    min-width: 0;
  }
  .wordmark {
    font-weight: 600;
    font-size: 16px;
    letter-spacing: -0.01em;
  }
  .meta {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-left: auto;
    white-space: nowrap;
  }

  main {
    padding: 12px 16px calc(var(--tabbar) + env(safe-area-inset-bottom) + 24px);
    min-width: 0;
  }
  @media (min-width: 900px) {
    main {
      max-width: 1280px;
      margin: 0 auto;
      padding: 24px 20px 48px;
    }
    main.workspace {
      max-width: none;
      padding: 0;
    }
  }

  nav a {
    text-decoration: none;
    color: var(--faint);
    transition: color 120ms;
  }
  nav a:hover {
    color: var(--ink);
  }
  nav a[aria-current="page"] {
    color: var(--accent);
  }
  .label {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  .bar {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 5;
    display: flex;
    padding-bottom: env(safe-area-inset-bottom);
    background: var(--surface);
    border-top: 1px solid var(--line);
  }
  .bar a {
    flex: 1;
    min-height: var(--tabbar);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    font-size: 11px;
  }

  .rail {
    display: flex;
    align-self: stretch;
    gap: 4px;
  }
  .rail a {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 12px;
    font-size: 14px;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
  }
  .rail a[aria-current="page"] {
    color: var(--ink);
    border-bottom-color: var(--accent);
  }
</style>
