<script lang="ts">
  import type { Star } from "$lib/model/types";

  // A starred directive's mark: a small drawn star and its rank, in the system voice at its
  // quietest. A directive is context, never a nag (ADR 0014), so it never takes a hue.
  type Props = { rank: Star };
  const { rank }: Props = $props();
</script>

<span class="star" title="starred directive, rank {rank} of 3">
  <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 .9l1.5 3.3 3.6.4-2.7 2.4.8 3.6L6 8.8 2.8 10.6l.8-3.6L.9 4.6l3.6-.4z" /></svg>
  <span class="r" aria-hidden="true">{rank}</span>
  <span class="sr">starred, rank {rank}</span>
</span>
