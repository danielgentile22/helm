<script lang="ts">
  /** A label and a value per line; rows with no value are left out. */
  let { rows }: { rows: [string, string | null][] } = $props();
</script>

<dl>
  {#each rows.filter(([, value]) => value) as [label, value] (label)}
    <dt>{label}</dt>
    <dd>{value}</dd>
  {/each}
</dl>

<style>
  dl {
    display: grid;
    grid-template-columns: 1fr;
    margin: 10px 0 0;
    font-size: 12px;
  }
  dt {
    color: var(--faint);
    margin-top: 6px;
  }
  dt:first-child {
    margin-top: 0;
  }
  dd {
    margin: 0;
    color: var(--dim);
    overflow-wrap: anywhere;
  }
  @media (min-width: 600px) {
    dl {
      grid-template-columns: 96px 1fr;
      column-gap: 12px;
      row-gap: 4px;
    }
    dt {
      margin-top: 0;
    }
  }
</style>
