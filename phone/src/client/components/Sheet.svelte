<script lang="ts">
  import type { Snippet } from "svelte";
  import { fade } from "svelte/transition";
  import { motion, sheetIn, sheetOut } from "../motion";

  let { onClose, children }: { onClose: () => void; children: Snippet } = $props();
</script>

<svelte:window onkeydown={(e) => e.key === "Escape" && onClose()} />

<div class="sheet" role="presentation" onclick={(e) => e.target === e.currentTarget && onClose()} transition:fade|global={{ duration: motion.base }}>
  <div class="panel" in:sheetIn|global out:sheetOut|global>
    {@render children()}
  </div>
</div>
