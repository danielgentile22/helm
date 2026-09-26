/**
 * Web push. A projection of the log: subscribes to every open ThreadLog and
 * fires on `turn.ended`, and on an `ask.opened` still pending after a short
 * grace, when nobody is watching that thread over SSE. The grace exists
 * because a rule denial arrives as an opened-and-answered pair; a
 * notification for a question nobody can answer would be noise.
 *
 * Subscriptions live in ~/.helm2/push/subscriptions.json keyed by endpoint,
 * written atomically. A 404/410 from the push service deletes the entry.
 * VAPID keys come from .env (HELM_VAPID_PUBLIC / HELM_VAPID_PRIVATE / HELM_VAPID_SUBJECT).
 *
 * "Nobody is watching" is ThreadLog.viewerCount() === 0: no open SSE stream
 * for that thread. Projections like this watcher and the mirror never count.
 * Heartbeats keep a dead phone connection from lingering more than ~2
 * intervals. Every outcome notifies, `orphaned` included: a turn that died
 * with the server is precisely the case where the work did not happen and
 * the user has to resend, so staying quiet loses the message.
 */

import webpush from "web-push";
import { askSummary } from "../../shared/protocol";
import type { AskPayload, PushPayload, ThreadEvent, ThreadId } from "../../shared/protocol";
import { atomicWrite } from "../util/atomicWrite";
import type { ThreadLog } from "./log";
import type { ThreadStore } from "./thread-store";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface PushSubscriptionRecord {
  readonly endpoint: string;
  readonly keys: { p256dh: string; auth: string };
  readonly label: string; // "iphone"
  readonly createdAt: string;
}

/** How much of the last assistant message a notification body carries. */
const PREVIEW_CHARS = 120;

/** Status codes that mean the subscription is gone for good, not failing transiently. */
const DEAD_CODES = new Set([404, 410]);

/** Long enough for a same-tick auto-denial to land, short enough that a real prompt reaches the phone at once. */
const ASK_GRACE_MS = 250;

export interface VapidKeys {
  readonly publicKey: string;
  readonly privateKey: string;
  readonly subject: string;
}

/** One attempt to reach one endpoint. Injected in tests; web-push in production. */
export type Send = (sub: PushSubscriptionRecord, payload: PushPayload) => Promise<unknown>;

function statusCodeOf(err: unknown): number | null {
  const code = (err as { statusCode?: unknown } | null)?.statusCode;
  return typeof code === "number" ? code : null;
}

export class PushService {
  /** endpoint -> record. The file is the same map, so a reload is a parse. */
  private records = new Map<string, PushSubscriptionRecord>();
  /** Resolves once the file has been read. Every public method awaits it. */
  private readonly loaded: Promise<void>;
  /** Serializes read-modify-write on the file so two changes cannot lose one. */
  private writes: Promise<unknown> = Promise.resolve();
  private readonly send: Send;
  private readonly askGraceMs: number;

  constructor(
    private readonly file: string,
    private readonly vapid: VapidKeys,
    private readonly threads: ThreadStore,
    deps?: { send?: Send; askGraceMs?: number },
  ) {
    this.askGraceMs = deps?.askGraceMs ?? ASK_GRACE_MS;
    this.send =
      deps?.send ??
      ((sub, payload) =>
        webpush.sendNotification({ endpoint: sub.endpoint, keys: { ...sub.keys } }, JSON.stringify(payload), {
          vapidDetails: { subject: this.vapid.subject, publicKey: this.vapid.publicKey, privateKey: this.vapid.privateKey },
        }));
    this.loaded = this.load();
  }

  private async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as Record<string, PushSubscriptionRecord>;
      this.records = new Map(Object.entries(parsed));
    } catch (err) {
      // No file yet is the normal state before the phone first subscribes.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.error(`[push] cannot read ${this.file}`, err);
    }
  }

  /** Idempotent on endpoint. */
  async subscribe(rec: PushSubscriptionRecord): Promise<void> {
    await this.loaded;
    await this.mutate((records) => records.set(rec.endpoint, rec));
  }

  async unsubscribe(endpoint: string): Promise<void> {
    await this.loaded;
    await this.mutate((records) => records.delete(endpoint));
  }

  publicKey(): string {
    return this.vapid.publicKey;
  }

  async list(): Promise<readonly PushSubscriptionRecord[]> {
    await this.loaded;
    return [...this.records.values()];
  }

  /** Apply a change to the map and persist the whole map. Serialized. */
  private mutate(change: (records: Map<string, PushSubscriptionRecord>) => void): Promise<void> {
    const run = this.writes.then(async () => {
      change(this.records);
      await mkdir(dirname(this.file), { recursive: true });
      await atomicWrite(this.file, JSON.stringify(Object.fromEntries(this.records), null, 2) + "\n");
    });
    this.writes = run.catch(() => undefined);
    return run;
  }

  /**
   * Attach to a log. Called by LogRegistry for every log it opens, so a
   * thread created after boot is covered too.
   */
  watch(log: ThreadLog): void {
    log.subscribe("projection", (ev) => {
      if (log.viewerCount() > 0) return;
      if (ev.kind === "turn.ended") void this.notify(log, ev);
      if (ev.kind === "ask.opened") {
        const timer = setTimeout(() => {
          if (log.viewerCount() === 0 && log.getHead().pendingAsks.some((a) => a.askId === ev.askId)) void this.notify(log, ev);
        }, this.askGraceMs);
        timer.unref();
      }
    });
  }

  /** Gather the preview and title the payload needs, then fire. Never throws. */
  private async notify(log: ThreadLog, ev: Extract<ThreadEvent, { kind: "turn.ended" | "ask.opened" }>): Promise<void> {
    try {
      await this.loaded;
      if (this.records.size === 0) return;
      const title = (await this.threads.get(log.threadId))?.title ?? null;
      if (ev.kind === "ask.opened") return await this.fireAll(askPayloadFor(log.threadId, title, ev.seq, ev.ask));
      // The head already carries this turn's text, so a notification costs no disk read.
      const last = log.getHead().lastText;
      await this.fireAll(payloadFor(log.threadId, title, ev, last?.turnId === ev.turnId ? last.text : null));
    } catch (err) {
      console.error(`[push] ${log.threadId}: notify failed`, err);
    }
  }

  private async fireAll(payload: PushPayload): Promise<void> {
    const records = [...this.records.values()];
    const dead: string[] = [];
    await Promise.all(
      records.map(async (rec) => {
        try {
          await this.send(rec, payload);
        } catch (err) {
          const code = statusCodeOf(err);
          if (code !== null && DEAD_CODES.has(code)) dead.push(rec.endpoint);
          else console.error(`[push] send to ${rec.endpoint} failed`, err);
        }
      }),
    );
    if (dead.length > 0) {
      console.log(`[push] dropping ${dead.length} dead subscription(s)`);
      await this.mutate((rs) => {
        for (const endpoint of dead) rs.delete(endpoint);
      });
    }
  }
}

/** Pure. Title from thread config, body from outcome plus the last text preview. */
export function payloadFor(
  threadId: ThreadId,
  title: string | null,
  ev: Extract<ThreadEvent, { kind: "turn.ended" }>,
  preview: string | null,
): PushPayload {
  return {
    threadId,
    title: title ?? "Helm",
    body: bodyFor(ev, preview),
    kind: ev.outcome,
    seq: ev.seq,
    url: `/t/${threadId}#end`,
  };
}

/** Pure. The body is the one line the list row and the mirror use for the same ask. */
export function askPayloadFor(threadId: ThreadId, title: string | null, seq: PushPayload["seq"], ask: AskPayload): PushPayload {
  return { threadId, title: title ?? "Helm", body: askSummary(ask).slice(0, PREVIEW_CHARS), kind: "ask", seq, url: `/t/${threadId}#end` };
}

/**
 * A notification has one line, so an `ok` body is the first non-empty line of
 * what the model said rather than a slice across a paragraph break. Claude
 * Code's replies lead with the answer, so the first line is the useful one.
 */
function bodyFor(ev: Extract<ThreadEvent, { kind: "turn.ended" }>, preview: string | null): string {
  switch (ev.outcome) {
    case "ok": {
      const line = (preview ?? "").split("\n").map((l) => l.trim()).find((l) => l.length > 0);
      return line ? line.slice(0, PREVIEW_CHARS) : "Turn finished";
    }
    case "error":
      return `Error: ${ev.error ?? "unknown"}`;
    case "interrupted":
      return "Interrupted";
    case "orphaned":
      return "Server restarted while this turn was running; resend if needed";
  }
}
