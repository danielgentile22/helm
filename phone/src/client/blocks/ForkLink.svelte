<script lang="ts">
  import type { ThreadId } from "../../shared/protocol";
  import { internalLink } from "../gestures";

  let { to, toTitle }: { to: ThreadId; toTitle: string } = $props();
</script>

<a class="forkto" href="/t/{to}" use:internalLink>Forked to {toTitle} <span aria-hidden="true">›</span></a>
