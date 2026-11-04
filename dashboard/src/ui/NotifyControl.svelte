<script lang="ts">
  import { pushState, turnOff, turnOn, type PushState } from "../lib/push";
  import Icon from "./Icon.svelte";

  let open = $state(false);
  let current = $state<PushState | null>(null);
  let busy = $state(false);
  let error = $state<string | null>(null);

  async function toggle(): Promise<void> {
    open = !open;
    if (open) {
      error = null;
      current = await pushState();
    }
  }

  async function change(on: boolean): Promise<void> {
    busy = true;
    error = await (on ? turnOn() : turnOff());
    current = await pushState();
    busy = false;
  }

  const words: Record<PushState, string> = {
    on: "Notifications are on for this device. An alert sends one, and the app icon shows how many are open.",
    off: "Get a notification when something goes wrong: a routine fails or goes quiet, a service is down, CI fails on your pull request, or an idea is due.",
    blocked: "Notifications are blocked for helm in this browser's settings. Allow them there, then come back.",
    "needs-home-screen":
      "On iPhone, notifications work from the home screen app only. In Safari tap Share, then Add to Home Screen, open helm from the home screen, and turn them on here.",
    unsupported: "This browser cannot receive notifications.",
  };
</script>

<div class="notify">
  <button
    class="bell"
    aria-label="Notifications"
    aria-expanded={open}
    aria-pressed={current === "on"}
    onclick={toggle}
  >
    <Icon name="bell" size={18} />
  </button>
  {#if open}
    <div class="panel card" role="dialog" aria-label="Notifications">
      <p class="title">Notifications</p>
      {#if current === null}
        <p class="sub">Checking this device…</p>
      {:else}
        <p class="sub">{words[current]}</p>
        {#if current === "off"}
          <button class="btn primary" disabled={busy} onclick={() => change(true)}>
            {busy ? "Turning on…" : "Turn on notifications"}
          </button>
        {:else if current === "on"}
          <button class="btn" disabled={busy} onclick={() => change(false)}>
            {busy ? "Turning off…" : "Turn off on this device"}
          </button>
        {/if}
      {/if}
      {#if error !== null}<p class="notice" role="alert">{error}</p>{/if}
    </div>
  {/if}
</div>

<style>
  .notify {
    position: relative;
  }
  .bell {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--faint);
    cursor: pointer;
  }
  .bell:hover,
  .bell[aria-expanded="true"] {
    color: var(--ink);
  }
  .bell[aria-pressed="true"] {
    color: var(--accent);
  }
  .panel {
    position: absolute;
    right: 0;
    top: 42px;
    z-index: 10;
    width: min(320px, calc(100vw - 32px));
    white-space: normal;
    box-shadow: 0 8px 24px rgb(0 0 0 / 0.25);
  }
  .panel p {
    margin: 0 0 10px;
  }
  .panel .sub {
    line-height: 1.45;
  }
</style>
