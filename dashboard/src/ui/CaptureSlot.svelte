<script lang="ts">
  // Unit 3 enables the box and wires it to the idea writer.
</script>

<form class="capture" data-slot="capture" onsubmit={(e) => e.preventDefault()}>
  <input type="text" placeholder="Throw an idea in" aria-label="Idea" disabled />
  <button type="submit" class="btn primary" disabled>Add</button>
</form>

<style>
  .capture {
    display: flex;
    gap: 8px;
  }
  input {
    flex: 1;
    min-width: 0;
    min-height: 44px;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: 10px;
    color: var(--ink);
    padding: 0 14px;
    font: inherit;
  }
  input::placeholder {
    color: var(--faint);
  }
  button {
    min-height: 44px;
    padding: 0 16px;
  }
  :disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
</style>
