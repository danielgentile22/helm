<script lang="ts">
  import type { Cursor } from "../../shared/protocol";
  import type { ConnState } from "../api";

  let { conn, seen, head, waiting }: { conn: ConnState; seen: Cursor; head: Cursor; waiting: boolean } = $props();

  const pct = $derived(head > 0 ? Math.min(100, Math.round((seen / head) * 100)) : 0);
</script>

<!-- Waiting outranks every connection state: a live stream is no comfort while the turn cannot move. -->
{#if waiting}
  <div class="statusbar wait"><span class="glyph">?</span>waiting on you</div>
{:else if conn === "connecting"}
  <div class="statusbar"><span class="spin"></span>connecting</div>
{:else if conn === "replaying"}
  <div class="statusbar cool">
    <span class="glyph">▾</span>replaying {seen} / {head}
    <span class="bar"><i style="width:{pct}%"></i></span>
  </div>
{:else if conn === "offline"}
  <!-- "retrying", not "queued sends will resend": api.ts drops a failed send, it does not queue it. -->
  <div class="statusbar mute"><span class="glyph">⊘</span>offline · retrying</div>
{/if}
