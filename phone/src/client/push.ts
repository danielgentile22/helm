/** Web push enrolment. */

import type { HelmClient } from "./api";

export async function swRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  return (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.register("/sw.js"));
}

export async function pushState(): Promise<"enabled" | "disabled" | "unsupported"> {
  if (!("PushManager" in window) || !("Notification" in window)) return "unsupported";
  const reg = await swRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub && Notification.permission === "granted" ? "enabled" : "disabled";
}

export async function enablePush(api: HelmClient): Promise<void> {
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("Notifications were not allowed on this device.");
  const reg = await swRegistration();
  if (!reg) throw new Error("This browser has no service worker, so push cannot be enabled.");
  const { key } = await api.pushPublicKey();
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidKey(key) as BufferSource });
  await api.pushSubscribe(sub.toJSON());
}

export function vapidKey(b64url: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (b64url.length % 4)) % 4);
  const bin = atob((b64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
