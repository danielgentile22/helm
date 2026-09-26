<script lang="ts">
  import type { HelmClient } from "../api";
  import { LABEL } from "../label";
  import { router } from "../route.svelte";
  import { createPasskey } from "../webauthn";

  let { api, token }: { api: HelmClient; token: string } = $props();

  let label = $state(LABEL);
  let busy = $state(false);
  let msg = $state("");
  let msgClass = $state("error");

  async function enroll(): Promise<void> {
    busy = true;
    try {
      const { challengeId, options } = await api.registerOptions(token, label.trim() || LABEL);
      const response = await createPasskey(options as Record<string, unknown>);
      await api.registerVerify(challengeId, response);
      msgClass = "muted";
      msg = "Passkey enrolled. Sign in next.";
      setTimeout(() => router.navigate("/login"), 800);
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err);
      busy = false;
    }
  }
</script>

<main class="screen">
  <div class="login">
    <h1>Enroll this phone</h1>
    <p class="muted">This link was printed by the server on your Mac and works once.</p>
    <div class="field">
      <label for="device-name">Device name</label>
      <input id="device-name" bind:value={label} placeholder="device name" />
    </div>
    <button class="btn primary" disabled={busy} onclick={enroll}>Create passkey</button>
    <p class={msgClass}>{msg}</p>
  </div>
</main>
