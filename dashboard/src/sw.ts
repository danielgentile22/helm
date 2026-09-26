// The service worker: listeners, and the strategy `lib/sw/policy` returns for each request.
// Every caching rule lives there. This file performs them and holds none.
//
// It is registered from the production bundle only, so `npm run dev` behaves exactly as it
// did before this existed. A new version takes over immediately rather than waiting for
// every tab to close, so opening the installed app after a build gets the new interface.

import { cacheKeyFor, strategyFor } from "./lib/sw/policy";

const CACHE = "helm-v1";
const SHELL = "/";

const sw = self as unknown as ServiceWorkerGlobalScope;

async function cacheFirst(request: Request, key: string): Promise<Response> {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(key);
  if (cached !== undefined) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(key, response.clone());
  return response;
}

async function networkFirst(request: Request, key: string): Promise<Response> {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(key, response.clone());
    return response;
  } catch (unreachable) {
    // The server is not answering. The last good response is served as itself, stamps
    // intact, so the page reads it the way it reads a live one and classifies its age
    // from `produced` (ADR 0020). Nothing here labels it.
    const cached = await cache.match(key);
    if (cached !== undefined) return cached;
    throw unreachable;
  }
}

sw.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.add(SHELL);
      await sw.skipWaiting();
    })(),
  );
});

sw.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name !== CACHE) await caches.delete(name);
      }
      await sw.clients.claim();
    })(),
  );
});

sw.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== sw.location.origin) return;
  const strategy = strategyFor(event.request.method, url.pathname);
  if (strategy === "network-only") return;
  const key = cacheKeyFor(url.pathname);
  event.respondWith(
    strategy === "cache-first" ? cacheFirst(event.request, key) : networkFirst(event.request, key),
  );
});
