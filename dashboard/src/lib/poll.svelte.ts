import type { Failure, Load } from "./api";

const INTERVAL = 60_000;
/** How soon to ask again while the answer says the server is still working on it. */
const SOON = 2_000;

export interface Poll<T> {
  readonly load: Load<T>;
  start(): void;
  stop(): void;
  /** Resolves once an answer fetched after this call is on screen, or the poll stops. */
  refresh(): Promise<void>;
  /** A write answered 401: show the sign in state, and retry from there. */
  signedOut(failure: Failure): void;
}

/** `busy` says the answer is about to change (a refresh is running on the server), so the
 *  poll asks again in two seconds instead of waiting the full minute. `every` is how often it
 *  asks otherwise. */
export function createPoll<T>(
  fetcher: () => Promise<Load<T>>,
  busy?: (data: T) => boolean,
  every: number = INTERVAL,
): Poll<T> {
  let load = $state<Load<T>>({ state: "loading" });
  let timer: ReturnType<typeof setInterval> | null = null;
  let soon: ReturnType<typeof setTimeout> | undefined;
  let latest = 0;
  let inflight = false;
  let waiters: (() => void)[] = [];

  function settle(): void {
    const done = waiters;
    waiters = [];
    for (const resolve of done) resolve();
  }

  async function fetchNow(): Promise<void> {
    const mine = ++latest;
    inflight = true;
    const next = await fetcher();
    // Only the newest request answers, and none after stop.
    if (mine !== latest) return;
    inflight = false;
    load = next;
    settle();
    clearTimeout(soon);
    if (timer !== null && next.state === "ready" && busy?.(next.data) === true) soon = setTimeout(nudge, SOON);
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
      timer = setInterval(nudge, every);
      addEventListener("focus", nudge);
      document.addEventListener("visibilitychange", onVisibility);
    },
    stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
      clearTimeout(soon);
      latest++;
      inflight = false;
      removeEventListener("focus", nudge);
      document.removeEventListener("visibilitychange", onVisibility);
      settle();
    },
    refresh() {
      // A retry from an error shows the skeleton; a refresh of good data keeps it on screen.
      if (load.state === "error") load = { state: "loading" };
      const done = new Promise<void>((resolve) => waiters.push(resolve));
      void fetchNow();
      return done;
    },
    signedOut(failure) {
      latest++;
      inflight = false;
      load = failure;
      settle();
    },
  };
}
