<script lang="ts" module>
  export type Tone = "pass" | "fail" | "pending" | "paused" | "unknown" | "off";
</script>

<script lang="ts">
  let { tone, label }: { tone: Tone; label: string } = $props();
</script>

<span class="dot {tone}" role="img" aria-label={label} title={label}></span>

<style>
  .dot {
    display: inline-block;
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }
  .pass {
    background: var(--ok);
  }
  .fail {
    background: var(--bad);
  }
  .pending {
    background: var(--warn);
  }
  .paused,
  .off {
    background: var(--off);
  }
  .unknown {
    border: 1px solid var(--faint);
  }
</style>
