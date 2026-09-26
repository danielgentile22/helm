<script lang="ts">
  import { ui } from "$lib/ui.svelte";

  // One screen, in the drawer, of what every mark on the map means and every key does. The
  // drawer rather than a surface of its own, because nothing floats but the drawer.
  const MARKS: readonly { mark: string; tone: string; words: string }[] = [
    { mark: "◆", tone: "", words: "a todo with a date" },
    { mark: "◇", tone: "", words: "a todo with no date" },
    { mark: "▲", tone: "late", words: "late" },
    { mark: "▮", tone: "event", words: "an event" },
    { mark: "○ ●", tone: "", words: "a daily, filled once done today" },
    { mark: "□ ■", tone: "", words: "a subtask, open and done" },
    { mark: "▸", tone: "cursor", words: "the row j and k are on" },
  ];

  const KEYS: readonly { keys: readonly string[]; words: string }[] = [
    { keys: ["1", "4"], words: "zoom a department, again to go back" },
    { keys: ["j", "k"], words: "move down and up the rows" },
    { keys: ["⏎"], words: "open the row, or the start line's thing" },
    { keys: ["x"], words: "done, into a five second undo window" },
    { keys: ["e"], words: "edit" },
    { keys: ["u"], words: "take back the newest tick" },
    { keys: ["n"], words: "new todo" },
    { keys: ["space"], words: "hold to talk" },
    { keys: ["?"], words: "this legend" },
    { keys: ["esc"], words: "close, then unzoom, then drop the cursor" },
  ];
</script>

<div class="kind">legend</div>
<h2 tabindex="-1">Marks and keys</h2>
<dl class="legend">
  {#each MARKS as m (m.words)}
    <dt class={m.tone}>{m.mark}</dt><dd>{m.words}</dd>
  {/each}
  <dt aria-hidden="true"><span class="rail"><i class="late" style="--pull:1.4"></i><i class="soon" style="--pull:1"></i><i class="event" style="--pull:.7"></i><i style="--pull:.5"></i></span></dt>
  <dd>pull as a length: late, due soon, an event, the rest</dd>
  <dt><span class="start-tag">start</span></dt><dd>the row the header says to start with</dd>
</dl>
<h3>keys</h3>
<dl class="legend">
  {#each KEYS as k (k.words)}
    <dt>{#each k.keys as key, i (key)}{#if i > 0}{k.keys[0] === "1" ? " to " : " "}{/if}<kbd>{key}</kbd>{/each}</dt><dd>{k.words}</dd>
  {/each}
</dl>
<div class="verbs">
  <button onclick={() => ui.toggleLegend()}><kbd>esc</kbd> close</button>
</div>
