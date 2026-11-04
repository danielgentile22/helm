<script lang="ts">
  type Name = "projects" | "ideas" | "background" | "devices" | "pin" | "chevron" | "bell";

  let { name, size = 20 }: { name: Name; size?: number } = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 20 20"
  fill="none"
  stroke="currentColor"
  stroke-width="1.5"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  {#if name === "projects"}
    <rect x="3" y="3" width="5.5" height="5.5" rx="1" />
    <rect x="11.5" y="3" width="5.5" height="5.5" rx="1" />
    <rect x="3" y="11.5" width="5.5" height="5.5" rx="1" />
    <rect x="11.5" y="11.5" width="5.5" height="5.5" rx="1" />
  {:else if name === "ideas"}
    <path d="M7.5 14.5h5M8.5 17h3" />
    <path d="M10 2.5a5 5 0 0 0-3 9c.6.5 1 1.2 1 2v1h4v-1c0-.8.4-1.5 1-2a5 5 0 0 0-3-9z" />
  {:else if name === "background"}
    <path d="M16.5 8.5A6.5 6.5 0 0 0 4.6 6.3" />
    <path d="M4.3 3v3.5h3.5" />
    <path d="M3.5 11.5a6.5 6.5 0 0 0 11.9 2.2" />
    <path d="M15.7 17v-3.5h-3.5" />
  {:else if name === "devices"}
    <rect x="3.5" y="4" width="13" height="9" rx="1.2" />
    <path d="M1.5 16h17" />
  {:else if name === "pin"}
    <path d="M7 3h6l-1 5 2.5 2.5v1.5h-9v-1.5L8 8z" />
    <path d="M10 12v5" />
  {:else if name === "bell"}
    <path d="M5 13.5V9a5 5 0 0 1 10 0v4.5l1.5 2h-13z" />
    <path d="M8.5 17.5a1.6 1.6 0 0 0 3 0" />
  {:else}
    <path d="M12.5 4.5L7 10l5.5 5.5" />
  {/if}
</svg>

<style>
  svg {
    display: block;
    flex: none;
  }
</style>
