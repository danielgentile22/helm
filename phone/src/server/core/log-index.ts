/**
 * A per-thread lookup table derived from the event log. The log is the truth;
 * the map is a cache that any miss rebuilds by rescanning from zero, which is
 * also how a restart recovers: the first lookup after boot refills the thread.
 */

import type { ThreadEvent, ThreadId } from "../../shared/protocol";
import type { LogRegistry } from "./log";

export class LogIndex<K extends string, V> {
  private readonly known = new Map<ThreadId, Map<K, V>>();

  /** `pick` names the events this index keys on; every other event is skipped. */
  constructor(
    private readonly logs: LogRegistry,
    private readonly pick: (ev: ThreadEvent) => readonly [K, V] | null,
  ) {}

  /** Record an entry whose event was just appended, so the next lookup needs no rescan. */
  remember(threadId: ThreadId, key: K, value: V): void {
    this.byThread(threadId).set(key, value);
  }

  /** The value for a key, rescanning the log on a miss. Null when the log never saw it. */
  async lookup(threadId: ThreadId, key: K): Promise<V | null> {
    return (await this.lookupAll(threadId, [key]))[0] ?? null;
  }

  /** One value per key in order, null where the log never saw it. Any miss costs one rescan, however many keys miss. */
  async lookupAll(threadId: ThreadId, keys: readonly K[]): Promise<readonly (V | null)[]> {
    const known = this.byThread(threadId);
    if (keys.some((k) => !known.has(k))) {
      const log = await this.logs.get(threadId);
      for await (const ev of log.read(0)) {
        const entry = this.pick(ev);
        if (entry) known.set(entry[0], entry[1]);
      }
    }
    return keys.map((k) => known.get(k) ?? null);
  }

  /** Drop a thread's map. The log keeps its events; only the cache goes. */
  purge(threadId: ThreadId): void {
    this.known.delete(threadId);
  }

  private byThread(threadId: ThreadId): Map<K, V> {
    let m = this.known.get(threadId);
    if (!m) this.known.set(threadId, (m = new Map()));
    return m;
  }
}
