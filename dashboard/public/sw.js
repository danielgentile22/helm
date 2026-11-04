// helm's service worker (ADR 0039). Two jobs: show an alert's push and set the app icon's
// badge, and on a tap open the app at the alert's tab. It caches nothing and never sees /api.
//
// A push carries {title, tab, count} and nothing else.

const TABS = new Set(["projects", "ideas", "background", "devices"]);

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    // A payload that is not JSON still shows a notification: iOS revokes a subscription
    // whose pushes show nothing.
  }
  const tab = TABS.has(payload.tab) ? payload.tab : "projects";
  const count = Number.isInteger(payload.count) ? payload.count : null;
  const shown = self.registration.showNotification(payload.title || "helm", {
    tag: `helm-${tab}`,
    data: { path: `/${tab}` },
    icon: "/icon-192.png",
  });
  const badge = count === null || !("setAppBadge" in self.navigator)
    ? Promise.resolve()
    : count > 0 ? self.navigator.setAppBadge(count) : self.navigator.clearAppBadge();
  event.waitUntil(Promise.all([shown, badge.catch(() => undefined)]));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = event.notification.data?.path || "/";
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = windows[0];
    if (open) {
      await open.focus();
      if (new URL(open.url).pathname !== path) await open.navigate(path);
      return;
    }
    await self.clients.openWindow(path);
  })());
});
