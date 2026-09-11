/**
 * Service worker. Two jobs only:
 *   1. cache the app shell so the PWA opens offline (the thread view then
 *      shows "offline" until attach() reconnects);
 *   2. show a push notification and, on click, focus or open `/t/<threadId>`.
 * It never proxies /api. It never stores thread content.
 */

import type { PushPayload } from "../shared/protocol";

export function onPush(payload: PushPayload): Promise<void> {
  throw new Error("not implemented");
}
export function onNotificationClick(url: string): Promise<void> {
  throw new Error("not implemented");
}
