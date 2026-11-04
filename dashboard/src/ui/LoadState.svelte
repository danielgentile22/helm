<script lang="ts" generics="T">
  import type { Snippet } from "svelte";
  import type { Load } from "../lib/api";
  import { signIn } from "../lib/auth";

  let {
    load,
    empty,
    isEmpty,
    onretry,
    children,
  }: {
    load: Load<T>;
    empty: string;
    isEmpty: (data: T) => boolean;
    onretry: () => void;
    children: Snippet<[T, number]>;
  } = $props();

  // A fast answer never flashes the skeleton.
  let slow = $state(false);
  $effect(() => {
    if (load.state !== "loading") return;
    slow = false;
    const timer = setTimeout(() => (slow = true), 150);
    return () => clearTimeout(timer);
  });

  let signingIn = $state(false);
  let signInError = $state<string | null>(null);

  async function startSignIn(): Promise<void> {
    signingIn = true;
    signInError = await signIn();
    signingIn = false;
    if (signInError === null) onretry();
  }
</script>

{#if load.state === "loading"}
  {#if slow}
    <div class="skeleton" aria-busy="true" aria-label="Loading">
      <span></span><span></span><span></span>
    </div>
  {/if}
{:else if load.state === "error" && load.kind === "unauthorized"}
  <div class="card state">
    <div class="title">Signed out</div>
    <p class="muted">This page needs your passkey over the tailnet.</p>
    <button class="btn primary" onclick={startSignIn} disabled={signingIn}>Sign in with your passkey</button>
    {#if signInError !== null}<p class="notice">{signInError}</p>{/if}
  </div>
{:else if load.state === "error"}
  <div class="card state">
    <p class="problem">{load.detail}</p>
    <button class="btn" onclick={onretry}>Try again</button>
  </div>
{:else if isEmpty(load.data)}
  <p class="empty">{empty}</p>
{:else}
  {@render children(load.data, load.at)}
{/if}

<style>
  .skeleton {
    display: grid;
    gap: 8px;
  }
  .skeleton span {
    display: block;
    height: 56px;
    border-radius: 10px;
    background: var(--surface);
    border: 1px solid var(--line);
  }
  .state p {
    margin: 4px 0 12px;
    overflow-wrap: anywhere;
  }
  .problem {
    color: var(--bad);
  }
</style>
