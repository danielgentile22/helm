<script lang="ts">
  import { glyphFor, glyphKind } from "$lib/model/derive";
  import type { Phase, Thing } from "$lib/model/types";

  // A thing's kind as its shape, with the word for it on hover and for a screen reader, so
  // "▲" is heard as "late" rather than as "black up-pointing triangle".
  type Props = { thing: Thing; phase: Phase };
  const { thing, phase }: Props = $props();

  const kind = $derived(glyphKind(thing, phase));
</script>

<span class="g" title={kind}><span aria-hidden="true">{glyphFor(thing, phase)}</span><span class="sr">{kind}</span></span>
