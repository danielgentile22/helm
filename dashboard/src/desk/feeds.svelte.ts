// The desk's three feeds and the habits that keep a page alive for weeks on a phone that
// never leaves it: polls that never overlap and never stop on an error, a wake lock taken
// again whenever iOS drops it, and a reload when the build changes or nothing has worked
// for a long while.

import { fetchJson, type PulsePoint, type PulseResponse, type T3Response } from "../lib/api";

export type Link = "ok" | "stale" | "signed-out";

/** Run `step` now and then every `every` ms, one at a time, and at once when the page comes
 *  back to the front. Returns the stop function. */
function repeat(step: () => Promise<void>, every: number): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let busy = false;
  let stopped = false;
  async function tick(): Promise<void> {
    if (busy || stopped) return;
    busy = true;
    clearTimeout(timer);
    try {
      await step();
    } finally {
      busy = false;
      if (!stopped) timer = setTimeout(tick, every);
    }
  }
  const onVisible = () => {
    if (document.visibilityState === "visible") void tick();
  };
  document.addEventListener("visibilitychange", onVisible);
  addEventListener("online", onVisible);
  void tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisible);
    removeEventListener("online", onVisible);
  };
}

const PULSE_MS = 2_000;
const THREADS_MS = 5_000;
const ALERTS_MS = 30_000;
const BUILD_MS = 5 * 60_000;
/** After this long with no good answer the page reloads itself, which clears anything a
 *  long sleep or a dropped network left wedged. */
const WEDGED_MS = 10 * 60_000;
/** Answers older than this draw dimmed, with the corner saying so. */
export const STALE_MS = 12_000;
/** Each request gives up after this, so one that hangs cannot stop its feed. */
const TIMEOUT_MS = 8_000;

export function createDesk() {
  let points = $state<PulsePoint[]>([]);
  let windowS = $state(300);
  let pulseAt = $state(0);
  let threads = $state<T3Response | null>(null);
  let threadsAt = $state(0);
  let alerts = $state<number | null>(null);
  let signedOut = $state(false);
  let lastGood = Date.now();
  let built: string | null = null;

  function good(): void {
    lastGood = Date.now();
    signedOut = false;
  }

  function failed(kind: string): void {
    if (kind === "unauthorized") signedOut = true;
    if (Date.now() - lastGood > WEDGED_MS && navigator.onLine) location.reload();
  }

  async function pulse(): Promise<void> {
    const newest = points.at(-1)?.at;
    const got = await fetchJson<PulseResponse>(
      newest === undefined ? "/api/machine/usage" : `/api/machine/usage?since=${encodeURIComponent(newest)}`,
      undefined,
      TIMEOUT_MS,
    );
    if (got.state !== "ready") return failed(got.kind);
    good();
    windowS = got.data.window_s;
    const merged = [...points, ...got.data.points];
    const end = Date.parse(merged.at(-1)?.at ?? "") || Date.now();
    // Stamps are the Mac's wall clock, so a restarted sampler just leaves a gap; only the
    // window is trimmed here.
    points = merged.filter((p) => Date.parse(p.at) > end - windowS * 1000 && Date.parse(p.at) <= end);
    pulseAt = Date.now();
  }

  async function t3(): Promise<void> {
    const got = await fetchJson<T3Response>("/api/t3/threads", undefined, TIMEOUT_MS);
    if (got.state !== "ready") return failed(got.kind);
    good();
    threads = got.data;
    threadsAt = Date.now();
  }

  async function alertCount(): Promise<void> {
    const got = await fetchJson<{ total: number }>("/api/alerts", undefined, TIMEOUT_MS);
    if (got.state !== "ready") return failed(got.kind);
    alerts = got.data.total;
  }

  /** A new build of the page is picked up without anyone touching the phone. */
  async function build(): Promise<void> {
    const got = await fetchJson<{ dist_built: string | null }>("/api/health", undefined, TIMEOUT_MS);
    if (got.state !== "ready") return;
    if (built !== null && got.data.dist_built !== null && got.data.dist_built !== built) location.reload();
    built = got.data.dist_built ?? built;
  }

  return {
    get points() {
      return points;
    },
    get windowS() {
      return windowS;
    },
    get pulseAt() {
      return pulseAt;
    },
    get threads() {
      return threads;
    },
    get threadsAt() {
      return threadsAt;
    },
    get alerts() {
      return alerts;
    },
    get signedOut() {
      return signedOut;
    },
    start(): () => void {
      const stops = [
        repeat(pulse, PULSE_MS),
        repeat(t3, THREADS_MS),
        repeat(alertCount, ALERTS_MS),
        repeat(build, BUILD_MS),
        keepAwake(),
      ];
      return () => stops.forEach((stop) => stop());
    },
    /** After a sign in: ask everything again now. */
    retry(): void {
      signedOut = false;
      void pulse();
      void t3();
      void alertCount();
    },
  };
}

/** The screen stays on while the desk is in front. iOS releases the lock whenever the page
 *  is hidden, so it is taken again on every return. Auto-Lock set to Never is the backstop
 *  on a phone where the API is missing. */
function keepAwake(): () => void {
  type Lock = { released: boolean; release(): Promise<void> };
  const api = (navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<Lock> } }).wakeLock;
  if (api === undefined) return () => undefined;
  let lock: Lock | null = null;
  const take = () => {
    if (document.visibilityState !== "visible" || (lock !== null && !lock.released)) return;
    api.request("screen").then((l) => (lock = l), () => undefined);
  };
  take();
  document.addEventListener("visibilitychange", take);
  // Some builds refuse a lock until the first touch.
  addEventListener("pointerdown", take);
  return () => {
    document.removeEventListener("visibilitychange", take);
    removeEventListener("pointerdown", take);
    void lock?.release();
  };
}
