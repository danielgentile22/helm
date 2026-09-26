/** Test doubles for the client: a scripted EventSource the test drives by calling emit / sync / fail. */

import type { SyncFrame, ThreadEvent } from "../shared/protocol";
import type { EventSourceLike } from "./api";

export class FakeES implements EventSourceLike {
  static instances: FakeES[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string; lastEventId: string }) => void) | null = null;
  private listeners = new Map<string, ((ev: { data: string }) => void)[]>();
  closed = false;
  constructor(readonly url: string) {
    FakeES.instances.push(this);
  }
  addEventListener(type: string, l: (ev: { data: string }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), l]);
  }
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.onopen?.({});
  }
  emit(seq: number): void {
    this.send({ seq, ts: "", kind: "thread.archived" } as ThreadEvent);
  }
  send(ev: ThreadEvent): void {
    this.onmessage?.({ data: JSON.stringify(ev), lastEventId: String(ev.seq) });
  }
  sync(frame: Partial<SyncFrame>): void {
    for (const l of this.listeners.get("sync") ?? []) l({ data: JSON.stringify({ headSeq: 0, generation: 0, session: "idle", openTurn: null, queuedCount: 0, ...frame }) });
  }
  fail(): void {
    this.onerror?.({});
  }
}
