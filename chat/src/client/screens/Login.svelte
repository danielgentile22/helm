<script lang="ts">
  import type { HelmClient } from "../api";
  import { assertPasskey } from "../webauthn";

  let { api, onSignedIn }: { api: HelmClient; onSignedIn: (me: { label: string }) => void } = $props();

  let busy = $state(false);
  let msg = $state("");

  async function signIn(): Promise<void> {
    busy = true;
    msg = "";
    try {
      const { challengeId, options } = await api.loginOptions();
      const response = await assertPasskey(options as Record<string, unknown>);
      onSignedIn(await api.loginVerify(challengeId, response));
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err);
      busy = false;
    }
  }
</script>

<main class="screen">
  <div class="login">
    <h1>Helm</h1>
    <p class="muted">Your Mac, from your phone.</p>
    <button class="btn primary" disabled={busy} onclick={signIn}>Sign in with Face ID</button>
    <p class="error">{msg}</p>
  </div>
</main>
