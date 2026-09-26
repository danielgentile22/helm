<script lang="ts">
  import { predLine, progress } from "$lib/model/detail";
  import type { LeadDetail } from "$lib/model/detail";
  import type { TodoThing } from "$lib/model/edit";

  // Only a todo, daily or event has notes, subtasks and a done-when; a routine never leads.
  type Props = { thing: TodoThing; detail: LeadDetail };
  const { thing, detail }: Props = $props();

  const count = $derived(progress(thing.subs));
  // Squares for a short list, so the count reads as a shape too. A long one is words alone.
  const meter = $derived(count === null || count.total > 8 ? "" : "■".repeat(count.done) + "□".repeat(count.total - count.done) + " ");
</script>

<!-- The drawer's lines, set in place under the lead's reason when the cell has room for
     them. The subtasks are read only here: there is no write for them, so they are text. -->
<div class="detail">
  {#if detail.noteLines > 0}
    <p class="notes" style="-webkit-line-clamp:{detail.noteLines}">{thing.notes}</p>
  {/if}
  {#if detail.subs !== null && count !== null}
    <div class="subs">
      <div class="fact">{detail.subs === "count" ? meter : ""}{count.done} of {count.total} done</div>
      {#if detail.subs === "list"}
        <ul>
          {#each thing.subs as sub (sub.text)}
            <li class:ok={sub.done}><span class="cb">{sub.done ? "■" : "□"}</span>{sub.text}</li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
  {#if detail.doneWhen && thing.doneWhen !== null}
    <div class="pred" class:ok={thing.doneWhen.ok === true}>{predLine(thing.doneWhen)}</div>
  {/if}
</div>
