<script lang="ts">
  import { untrack } from "svelte";
  import { clock } from "$lib/clock.svelte";
  import { talk } from "$lib/talk.svelte";
  import { ui } from "$lib/ui.svelte";
  import type { Phase } from "$lib/talk.svelte";

  type Face = { cls: string; label: string };

  // Keyed by the phase name so a new phase is a row here, not another branch. Every row has
  // a word, and the stylesheet gives every row but idle its own shape.
  const FACES: Record<Phase["name"], Face> = {
    idle: { cls: "idle", label: "hold space to talk" },
    listening: { cls: "listening", label: "listening" },
    transcribing: { cls: "transcribing", label: "transcribing" },
    working: { cls: "working", label: "working" },
    speaking: { cls: "speaking", label: "speaking" },
    offline: { cls: "offline", label: "voice offline" },
    error: { cls: "failed", label: "" },
  };

  // The tick is the only dependency. poll() reads the phase to decide whether to skip, and
  // without untrack that read would make every transition schedule another poll.
  $effect(() => {
    void clock.minute;
    untrack(() => {
      void talk.poll();
    });
  });

  const face = $derived.by(() => {
    const now = talk.phase;
    const base = FACES[now.name];
    if (now.name === "idle") return { cls: base.cls, label: ui.phone ? "hold to talk" : base.label };
    if (now.name === "error") return { cls: base.cls, label: now.message };
    if (now.name === "working" && now.refused) return { cls: base.cls, label: "still working" };
    return base;
  });

  const said = $derived(talk.confirmation);
  const rows = $derived(talk.actions.map((taken) => taken.row));
  const full = $derived([talk.transcript, said, ...rows].filter((part) => part !== "").join(" / "));
</script>

<div class="talk {face.cls}">
  <span class="state" title={face.label}><span class="s"></span>{face.label}</span>
  {#if talk.transcript !== ""}
    <span class="heard" title={full}>
      <b>you</b>{talk.transcript}
      {#if said !== ""}
        <b>helm</b>{said}
        {#each rows as row}<span class="wrote">{row}</span>{/each}
      {/if}
    </span>
  {/if}
</div>
