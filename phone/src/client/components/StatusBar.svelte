<script lang="ts">
  import type { Cursor } from "../../shared/protocol";
  import type { Conn } from "../thread";

  let { conn, seen, head }: { conn: Conn; seen: Cursor; head: Cursor } = $props();

  const pct = $derived(head > 0 ? Math.min(100, Math.round((seen / head) * 100)) : 0);
</script>

{#if conn === "connecting"}
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
