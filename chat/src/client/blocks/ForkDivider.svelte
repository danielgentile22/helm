<script lang="ts">
  import type { Seq, ThreadId } from "../../shared/protocol";
  import { internalLink } from "../gestures";

  let { from, fromTitle, memory, atSeq }: { from: ThreadId; fromTitle: string | null; memory: "session" | "fresh"; atSeq: Seq | null } = $props();

  const href = $derived(atSeq === null ? `/t/${from}` : `/t/${from}#seq=${atSeq}`);
</script>

<div class="forkline">
  <span class="hair" aria-hidden="true"></span>
  <a {href} use:internalLink>Forked from {fromTitle ?? "Untitled"}</a>
  <span class="hair" aria-hidden="true"></span>
</div>
{#if memory === "fresh"}
  <p class="forknote">Claude starts here with no memory of the turns above</p>
{/if}
