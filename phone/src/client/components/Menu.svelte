<script lang="ts">
  let { onRename, onModel, onInfo, onSave, onArchive, onClose }: { onRename: () => void; onModel: () => void; onInfo: () => void; onSave: () => void; onArchive: () => void; onClose: () => void } = $props();
</script>

<svelte:window onkeydown={(e) => e.key === "Escape" && onClose()} />

<div class="menuscrim" onclick={onClose} role="presentation"></div>
<div class="menu">
  <button class="mitem" type="button" onclick={onRename}>Rename</button>
  <button class="mitem" type="button" onclick={onModel}>Model and effort</button>
  <button class="mitem" type="button" onclick={onInfo}>Info</button>
  <button class="mitem" type="button" onclick={onSave}>Save to vault</button>
  <button class="mitem" type="button" onclick={onArchive}>Archive</button>
</div>
