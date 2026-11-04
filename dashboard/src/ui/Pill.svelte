<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    tone = "plain",
    title,
    children,
  }: { tone?: "plain" | "accent" | "warn" | "bad"; title?: string; children: Snippet } = $props();
</script>

<span class="pill {tone}" {title}>{@render children()}</span>

<style>
  .pill {
    display: inline-block;
    flex: none;
    font-size: 11px;
    line-height: 16px;
    padding: 1px 8px;
    border-radius: 999px;
    border: 1px solid var(--line);
    color: var(--dim);
    white-space: nowrap;
  }
  .accent {
    color: var(--accent);
    border-color: var(--accent-line);
  }
  .warn {
    color: var(--warn);
    border-color: color-mix(in srgb, var(--warn) 40%, transparent);
  }
  .bad {
    color: var(--bad);
    border-color: color-mix(in srgb, var(--bad) 40%, transparent);
  }
</style>
