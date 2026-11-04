// Turning push notifications on and off for this browser (ADR 0039). The permission prompt
// only ever opens from a tap, which iOS requires.

import { fetchJson } from "./api";

export type PushState = "on" | "off" | "blocked" | "needs-home-screen" | "unsupported";

const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent);

function standalone(): boolean {
  return matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
}

export function registerWorker(): void {
  if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  return (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.register("/sw.js"));
}

export async function pushState(): Promise<PushState> {
  if (!("PushManager" in window) || !("Notification" in window) || !("serviceWorker" in navigator)) {
    return IOS && !standalone() ? "needs-home-screen" : "unsupported";
  }
  if (Notification.permission === "denied") return "blocked";
  const sub = await (await registration())?.pushManager.getSubscription();
  return sub && Notification.permission === "granted" ? "on" : "off";
}

function vapidKey(b64url: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (b64url.length % 4)) % 4);
  const bin = atob((b64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Returns null when notifications are on, or what went wrong in words. */
export async function turnOn(): Promise<string | null> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return "Notifications were not allowed on this device.";
  const reg = await registration();
  if (reg === null) return "This browser has no service worker, so it cannot receive notifications.";
  const key = await fetchJson<{ key: string }>("/api/push/key");
  if (key.state !== "ready") return key.detail;
  try {
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidKey(key.data.key) });
    const saved = await fetchJson("/api/push/subscribe", sub.toJSON());
    return saved.state === "ready" ? null : saved.detail;
  } catch (e) {
    return `The browser refused the subscription (${e instanceof Error ? e.message : String(e)}).`;
  }
}

export async function turnOff(): Promise<string | null> {
  const sub = await (await registration())?.pushManager.getSubscription();
  if (!sub) return null;
  const removed = await fetchJson("/api/push/unsubscribe", { endpoint: sub.endpoint });
  await sub.unsubscribe();
  return removed.state === "ready" ? null : removed.detail;
}
