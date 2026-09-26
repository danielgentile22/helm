<script lang="ts">
  import { auth } from "$lib/auth.svelte";

  const gate = $derived(auth.gate);
  const busy = $derived(gate.name === "out" || gate.name === "enroll" ? gate.busy : false);
  const message = $derived(gate.name === "out" || gate.name === "enroll" ? gate.message : "");

  function label(): string {
    return /iPhone|iPad/.test(navigator.userAgent) ? "iphone" : "browser";
  }
</script>

<div class="gate">
  <span class="mark">HELM</span>
  {#if gate.name === "checking"}
    <p class="hint">checking</p>
  {:else if gate.name === "enroll"}
    <p class="hint">this link registers a passkey for this device</p>
    <button class="go" disabled={busy} onclick={() => void auth.enroll(label())}>
      {busy ? "waiting for Face ID" : "register this device"}
    </button>
  {:else}
    <button class="go" disabled={busy} onclick={() => void auth.signIn()}>
      {busy ? "waiting for Face ID" : "sign in with Face ID"}
    </button>
  {/if}
  {#if message !== ""}<p class="fail">{message}</p>{/if}
</div>

<style>
  .gate {
    position: fixed;
    inset: 0;
    display: grid;
    place-content: center;
    justify-items: center;
    gap: 18px;
    padding: 24px;
    text-align: center;
  }
  .mark {
    color: var(--bone);
    letter-spacing: 0.24em;
    font-size: 12px;
  }
  .hint {
    color: var(--bone-faint);
    font-size: 12px;
    max-width: 28ch;
  }
  .go {
    border: 1px solid var(--plane-hot);
    border-radius: 4px;
    padding: 14px 22px;
    color: var(--bone);
    font-size: 14px;
    letter-spacing: 0.04em;
    text-align: center;
    min-width: 240px;
  }
  .go:disabled {
    color: var(--bone-faint);
    cursor: default;
  }
  .fail {
    color: var(--unstable);
    font-size: 12px;
    max-width: 36ch;
  }
</style>
