import type { Load } from "./api";

const INTERVAL = 60_000;

export interface Poll<T> {
  readonly load: Load<T>;
  start(): void;
  stop(): void;
  refresh(): void;
}

export function createPoll<T>(fetcher: () => Promise<Load<T>>): Poll<T> {
  let load = $state<Load<T>>({ state: "loading" });
  let timer: ReturnType<typeof setInterval> | null = null;
  let latest = 0;
  let inflight = false;

  async function fetchNow(): Promise<void> {
    const mine = ++latest;
    inflight = true;
    const next = await fetcher();
    // Only the newest request answers, and none after stop.
    if (mine !== latest) return;
    inflight = false;
    load = next;
  }

  // Focus and visibilitychange fire together on return; one fetch covers both.
  function nudge(): void {
    if (!inflight) void fetchNow();
  }

  function onVisibility(): void {
    if (document.visibilityState === "visible") nudge();
  }

  return {
    get load() {
      return load;
    },
    start() {
      if (timer !== null) return;
      void fetchNow();
      timer = setInterval(nudge, INTERVAL);
      addEventListener("focus", nudge);
      document.addEventListener("visibilitychange", onVisibility);
    },
    stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
      latest++;
      inflight = false;
      removeEventListener("focus", nudge);
      document.removeEventListener("visibilitychange", onVisibility);
    },
    refresh() {
      // A retry from an error shows the skeleton; a refresh of good data keeps it on screen.
      if (load.state === "error") load = { state: "loading" };
      void fetchNow();
    },
  };
}
