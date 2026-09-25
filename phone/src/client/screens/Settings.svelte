<script lang="ts">
  import { EFFORTS, PERMISSION_MODES, THEMES, type Effort, type HelmSettings, type ModelChoice, type PermissionMode, type SettingsPatch } from "../../shared/protocol";
  import type { HelmClient } from "../api";
  import DirBrowser from "../components/DirBrowser.svelte";
  import { shortPath } from "../format";
  import { models } from "../models";
  import { enablePush, pushState, swRegistration } from "../push";
  import { router } from "../route.svelte";
  import { settings } from "../settings.svelte";

  let { api }: { api: HelmClient } = $props();

  type Card = "appearance" | "notifications" | "passkeys" | "defaults" | "about";

  let catalog = $state<readonly ModelChoice[]>([]);
  let push = $state<"enabled" | "disabled" | "unsupported" | null>(null);
  let passkeys = $state<readonly { label: string; createdAt: string }[]>([]);
  let about = $state<{ version: string; host: string } | null>(null);
  let errs = $state<Partial<Record<Card, string>>>({});
  let dirOpen = $state(false);
  let picked = $state("");

  const value = $derived(settings.value);
  const chosen = $derived(catalog.find((c) => c.id === value?.defaultModel));
  const pushWords = $derived(push === "enabled" ? "enabled on this device" : push === "disabled" ? "not enabled" : push === "unsupported" ? "not supported here" : "checking");

  const MODE_WORDS: Record<PermissionMode, string> = { ask: "Ask", bypass: "Bypass" };

  const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
  const fail = (card: Card, e: unknown): void => void (errs = { ...errs, [card]: message(e) });
  const clear = (card: Card): void => void (errs = { ...errs, [card]: "" });

  async function patch(card: Card, p: SettingsPatch): Promise<void> {
    try {
      await settings.patch(api, p);
      clear(card);
    } catch (e) {
      fail(card, e);
    }
  }

  async function togglePush(): Promise<void> {
    try {
      if (push === "enabled") {
        const sub = await (await swRegistration())?.pushManager.getSubscription();
        if (sub) {
          await api.pushUnsubscribe(sub.endpoint);
          await sub.unsubscribe();
        }
      } else {
        await enablePush(api);
      }
      clear("notifications");
    } catch (e) {
      fail("notifications", e);
    }
    push = await pushState();
  }

  $effect(() => {
    void (async () => {
      push = await pushState();
      catalog = await models(api).catch(() => [] as readonly ModelChoice[]);
      try {
        passkeys = await api.listPasskeys();
      } catch (e) {
        fail("passkeys", e);
      }
      try {
        about = await api.about();
      } catch (e) {
        fail("about", e);
      }
    })();
  });
</script>

<main class="screen">
  <header class="topbar">
    <button class="icon-btn" aria-label="Back" onclick={() => router.navigate("/")}>
      <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3 5 8l5 5" /></svg>
    </button>
    <h1>Settings</h1>
  </header>

  <div class="sbody">
    {#if value}
      <div class="sgroup">
        <div class="lbl">Appearance</div>
        <div class="item">
          <span class="t"><span class="a">Theme</span><span class="b">stored on the server so phone and laptop agree</span></span>
          <span class="seg">
            {#each THEMES as t (t)}
              <button aria-pressed={value.theme === t} onclick={() => void patch("appearance", { theme: t })}>{value.theme === t ? "✓ " : ""}{t[0].toUpperCase() + t.slice(1)}</button>
            {/each}
          </span>
        </div>
      </div>
      {#if errs.appearance}<p class="error">▲ {errs.appearance}</p>{/if}

      <div class="sgroup">
        <div class="lbl">Notifications</div>
        <div class="item">
          <span class="t"><span class="a">Push notifications</span><span class="b">{pushWords}</span></span>
          {#if push === "enabled" || push === "disabled"}
            <button class="btn small" onclick={togglePush}>{push === "enabled" ? "Disable" : "Enable"}</button>
          {/if}
        </div>
      </div>
      {#if errs.notifications}<p class="error">▲ {errs.notifications}</p>{/if}

      <div class="sgroup">
        <div class="lbl">Passkeys</div>
        {#each passkeys as k (k.label + k.createdAt)}
          <div class="item">
            <span class="t"><span class="a">{k.label}</span><span class="b">enrolled {new Date(k.createdAt).toLocaleDateString()}</span></span>
          </div>
        {:else}
          <div class="item"><span class="t"><span class="a">No passkeys enrolled</span></span></div>
        {/each}
      </div>
      {#if errs.passkeys}<p class="error">▲ {errs.passkeys}</p>{/if}

      <div class="sgroup">
        <div class="lbl">New thread defaults</div>
        <div class="item">
          <span class="t"><span class="a">Model</span></span>
          <span class="v">
            <select aria-label="Default model" value={value.defaultModel ?? ""} onchange={(e) => void patch("defaults", { defaultModel: (e.currentTarget.value || null) as HelmSettings["defaultModel"] })}>
              <option value="">No preference</option>
              {#each catalog as m (m.id)}<option value={m.id}>{m.label}</option>{/each}
            </select>
          </span>
        </div>
        <div class="item" hidden={chosen !== undefined && !chosen.supportsEffort}>
          <span class="t"><span class="a">Effort</span></span>
          <span class="v">
            <select aria-label="Default effort" value={value.defaultEffort} onchange={(e) => void patch("defaults", { defaultEffort: e.currentTarget.value as Effort })}>
              {#each chosen?.efforts ?? EFFORTS as e (e)}<option value={e}>{e}</option>{/each}
            </select>
          </span>
        </div>
        <div class="item">
          <span class="t"><span class="a">Permissions</span><span class="b">threads in the vault always start in bypass</span></span>
          <span class="seg">
            {#each PERMISSION_MODES as m (m)}
              <button aria-pressed={value.defaultPermissionMode === m} onclick={() => void patch("defaults", { defaultPermissionMode: m })}>{MODE_WORDS[m]}</button>
            {/each}
          </span>
        </div>
        <button
          class="item"
          onclick={() => {
            picked = value.defaultCwd;
            dirOpen = true;
          }}
        >
          <span class="t"><span class="a">Working directory</span></span>
          <span class="v">{shortPath(value.defaultCwd)} ›</span>
        </button>
      </div>
      {#if errs.defaults}<p class="error">▲ {errs.defaults}</p>{/if}

      <div class="sgroup">
        <div class="lbl">About</div>
        <div class="item"><span class="t"><span class="a">Version</span></span><span class="v">{about?.version ?? ""}</span></div>
        <div class="item"><span class="t"><span class="a">Host</span></span><span class="v">{about?.host ?? ""}</span></div>
      </div>
      {#if errs.about}<p class="error">▲ {errs.about}</p>{/if}
    {:else}
      <p class="muted center">Loading settings</p>
    {/if}
  </div>

  {#if dirOpen && value}
    <div class="sheet" onclick={(e) => e.target === e.currentTarget && (dirOpen = false)} role="presentation">
      <div class="panel">
        <h2>Working directory</h2>
        <DirBrowser {api} initial={value.defaultCwd} onPick={(p) => (picked = p)} />
        <div class="actions">
          <button class="btn" onclick={() => (dirOpen = false)}>Cancel</button>
          <span class="grow"></span>
          <button
            class="btn primary"
            onclick={() => {
              dirOpen = false;
              void patch("defaults", { defaultCwd: picked });
            }}>Use this directory</button
          >
        </div>
      </div>
    </div>
  {/if}
</main>
