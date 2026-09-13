<script lang="ts">
  /**
   * A file the model sent to the phone. One tap fetches the bytes and hands
   * them to the native share sheet (Save to Files, Save Image, AirDrop, ...).
   * Safari only opens the sheet inside a user gesture, and a slow fetch can
   * outlive it; then the card keeps the blob and asks for one more tap.
   * Without a share sheet (laptop browsers) the tap opens the file in a tab.
   */
  import { fmtBytes } from "../../shared/protocol";
  import type { FileItem } from "../transcript";

  let { line, url, fetch: fetchFile }: { line: FileItem; url: string; fetch: (onProgress: (bytes: number) => void) => Promise<Blob> } = $props();

  type State = { tag: "idle" } | { tag: "fetching"; bytes: number } | { tag: "ready"; file: File } | { tag: "gone" } | { tag: "failed"; reason: string };
  let state = $state<State>({ tag: "idle" });

  const KIND: readonly [RegExp, string, string][] = [
    [/^image\//, "IMG", "image"],
    [/^application\/pdf$/, "PDF", "PDF"],
    [/^video\//, "VID", "video"],
    [/^audio\//, "AUD", "audio"],
    [/^text\/|json$/, "TXT", "text"],
  ];
  const kind = $derived(KIND.find(([re]) => re.test(line.mime)) ?? [/./, "FILE", "file"]);
  const isPdf = $derived(line.mime === "application/pdf");
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function" && typeof navigator.canShare === "function";

  function toFile(blob: Blob): File {
    return new File([blob], line.name, { type: line.mime });
  }

  async function share(file: File): Promise<void> {
    if (!canShare || !navigator.canShare({ files: [file] })) {
      window.open(url, "_blank", "noopener");
      state = { tag: "idle" };
      return;
    }
    try {
      await navigator.share({ files: [file] });
      state = { tag: "idle" };
    } catch (err) {
      // AbortError is the user closing the sheet; anything else (usually a lost gesture) asks for one more tap.
      state = err instanceof Error && err.name === "AbortError" ? { tag: "idle" } : { tag: "ready", file };
    }
  }

  async function tap(): Promise<void> {
    if (state.tag === "fetching") return;
    if (state.tag === "ready") return share(state.file);
    if (!canShare) {
      window.open(url, "_blank", "noopener");
      return;
    }
    state = { tag: "fetching", bytes: 0 };
    try {
      const blob = await fetchFile((bytes) => (state = { tag: "fetching", bytes }));
      await share(toFile(blob));
    } catch (err) {
      const status = (err as { status?: number }).status;
      state = status === 404 ? { tag: "gone" } : { tag: "failed", reason: err instanceof Error ? err.message : "download failed" };
    }
  }

  const progress = $derived(state.tag === "fetching" && line.bytes > 0 ? Math.min(100, Math.round((state.bytes / line.bytes) * 100)) : null);
</script>

<div class="file-card" class:gone={state.tag === "gone"}>
  <button class="file-main" onclick={tap} disabled={state.tag === "fetching" || state.tag === "gone"} aria-label={`${kind[2]} ${line.name}, ${fmtBytes(line.bytes)}. ${state.tag === "ready" ? "Tap to share" : "Tap to save or share"}`}>
    <span class="badge" aria-hidden="true">{kind[1]}</span>
    <span class="meta">
      <span class="name">{line.name}</span>
      <span class="sub">
        {#if state.tag === "fetching"}
          fetching{progress !== null ? ` · ${progress}%` : ""}
        {:else if state.tag === "ready"}
          ready · tap to share
        {:else if state.tag === "gone"}
          no longer on the Mac
        {:else if state.tag === "failed"}
          {state.reason} · tap to retry
        {:else}
          {fmtBytes(line.bytes)} · tap to save or share
        {/if}
      </span>
      {#if line.note}<span class="note-line">{line.note}</span>{/if}
    </span>
  </button>
  {#if isPdf && state.tag !== "gone"}
    <a class="btn small file-open" href={url} target="_blank" rel="noopener">Open</a>
  {/if}
</div>
