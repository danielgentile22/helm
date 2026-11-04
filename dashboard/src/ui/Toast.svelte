<script lang="ts">
  import type { Toast } from "../lib/ideas.svelte";

  let { toast }: { toast: Toast | null } = $props();
</script>

<div class="dock" role="status" aria-live="polite">
  {#if toast !== null}
    {#key toast.key}
      <div class="toast">
        <span class="grow">{toast.text}</span>
        <button class="undo" onclick={toast.undo}>Undo</button>
      </div>
    {/key}
  {/if}
</div>

<style>
  .dock {
    position: fixed;
    left: 16px;
    right: 16px;
    bottom: calc(var(--tabbar) + env(safe-area-inset-bottom) + 12px);
    z-index: 6;
    display: flex;
    justify-content: center;
    pointer-events: none;
  }
  @media (min-width: 900px) {
    .dock {
      bottom: 24px;
    }
  }
  .toast {
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: 12px;
    width: min(100%, 360px);
    padding: 4px 4px 4px 16px;
    background: var(--ink);
    color: var(--bg);
    border-radius: 10px;
    box-shadow: 0 6px 24px rgb(0 0 0 / 0.3);
    animation: rise 160ms ease-out;
  }
  .undo {
    min-height: 40px;
    padding: 0 14px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--accent-line);
    font-weight: 600;
    cursor: pointer;
  }
  .undo:hover {
    background: color-mix(in srgb, var(--bg) 12%, transparent);
  }
  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .toast {
      animation: none;
    }
  }
</style>
