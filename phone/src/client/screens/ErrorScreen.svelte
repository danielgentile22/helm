<script lang="ts">
  let { error }: { error: unknown } = $props();
</script>

<main class="screen">
  <p class="center error">Helm could not load: {error instanceof Error ? error.message : String(error)}</p>
  <p class="center"><button class="btn" onclick={() => location.reload()}>Retry</button></p>
</main>
