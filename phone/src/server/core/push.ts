/**
 * Web push. A projection of the log: subscribes to every open ThreadLog and
 * fires on `turn.ended` when nobody is watching that thread over SSE.
 *
 * Subscriptions live in ~/.helm2/push/subscriptions.json keyed by endpoint,
 * written atomically. A 404/410 from the push service deletes the entry.
 * VAPID keys come from .env (HELM_VAPID_PUBLIC / HELM_VAPID_PRIVATE / HELM_VAPID_SUBJECT).
 */

import type { PushPayload, ThreadEvent, ThreadId } from "../../shared/protocol";
import type { LogRegistry, ThreadLog } from "./log";
import type { ThreadStore } from "./thread-store";

export interface PushSubscriptionRecord {
  readonly endpoint: string;
  readonly keys: { p256dh: string; auth: string };
  readonly label: string; // "iphone"
  readonly createdAt: string;
}

export class PushService {
  constructor(
    private readonly file: string,
    private readonly vapid: { publicKey: string; privateKey: string; subject: string },
    private readonly threads: ThreadStore,
  ) {}

  /** Idempotent on endpoint. */
  subscribe(rec: PushSubscriptionRecord): Promise<void> {
    throw new Error("not implemented");
  }
  unsubscribe(endpoint: string): Promise<void> {
    throw new Error("not implemented");
  }
  publicKey(): string {
    throw new Error("not implemented");
  }

  /**
   * Attach to a log. Called by LogRegistry for every log it opens, so a
   * thread created after boot is covered too.
   */
  watch(log: ThreadLog): void {
    // TODO(push PR): log.subscribe(ev => { if (shouldNotify(ev, log.subscriberCount())) void this.fireAll(payloadFor(threadId, config, ev)) })
    void log;
  }

  private fireAll(payload: PushPayload): Promise<void> {
    // TODO: for each record: web-push sendNotification; on 404/410 remove; never throw
    throw new Error("not implemented");
  }
}

/**
 * Pure. Notify on turn.ended when no SSE subscriber is attached. The SSE
 * subscriber count is the proxy for "the app is open"; heartbeats keep a
 * dead phone connection from lingering more than ~2 intervals.
 */
export function shouldNotify(ev: ThreadEvent, liveSubscribers: number): boolean {
  throw new Error("not implemented");
}

/** Pure. Title from thread config, body from outcome plus the last text preview. */
export function payloadFor(
  threadId: ThreadId,
  title: string | null,
  ev: Extract<ThreadEvent, { kind: "turn.ended" }>,
  preview: string | null,
): PushPayload {
  throw new Error("not implemented");
}
