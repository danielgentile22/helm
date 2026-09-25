/// <reference lib="webworker" />
/**
 * Service worker. Two jobs only:
 *   1. cache the app shell so the PWA opens offline (the thread view then
 *      shows "offline" until attach() reconnects);
 *   2. show a push notification and, on click, focus or open `/t/<threadId>`.
 * It never proxies /api. It never stores thread content.
 */

import type { PushPayload } from "../shared/protocol";

declare const self: ServiceWorkerGlobalScope;

const SHELL = "helm-shell-v1";
const SHELL_FILES = ["/", "/app.js", "/app.css", "/manifest.webmanifest", "/icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) return;
  const shellPath = url.pathname.startsWith("/t/") ? "/" : url.pathname;
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok && SHELL_FILES.includes(shellPath)) void caches.open(SHELL).then((c) => c.put(shellPath, res.clone()));
    return res;
  }).catch(async () => (await caches.match(shellPath)) ?? Response.error()));
});

/**
 * An ask carries its own tag so a turn-ended notification for the same thread
 * neither replaces it nor is replaced by it, and it stays on screen until it
 * is tapped: the turn cannot move until someone answers.
 */
export async function onPush(payload: PushPayload): Promise<void> {
  const ask = payload.kind === "ask";
  await self.registration.showNotification(payload.title, {
    body: payload.body,
    tag: ask ? `helm-ask-${payload.threadId}` : `helm-${payload.threadId}`,
    requireInteraction: ask,
    data: { url: payload.url, threadId: payload.threadId },
    icon: "/icon-192.png",
  });
}

/**
 * A tab already on this thread is told to scroll rather than navigated: the
 * url carries a `#end` fragment, and a same-document fragment change does not
 * reload, so the app would otherwise sit where the user left it.
 */
export async function onNotificationClick(url: string, threadId: string | null): Promise<void> {
  const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const path = threadId === null ? null : `/t/${threadId}`;
  for (const c of all) {
    if (path !== null && new URL(c.url).pathname === path) {
      await c.focus();
      c.postMessage({ kind: "helm.open", threadId, scroll: "end" });
      return;
    }
  }
  const any = all[0];
  if (any) {
    await any.navigate(url);
    await any.focus();
    return;
  }
  await self.clients.openWindow(url);
}

self.addEventListener("push", (e) => {
  const payload = e.data?.json() as PushPayload | undefined;
  if (payload) e.waitUntil(onPush(payload));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const data = e.notification.data as { url?: string; threadId?: string } | undefined;
  e.waitUntil(onNotificationClick(data?.url ?? "/", data?.threadId ?? null));
});
