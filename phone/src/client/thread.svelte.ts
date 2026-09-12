/**
 * One open thread: the pure fold plus the attach state, as reactive state.
 *
 * `view` and `summary` are `$state.raw` because fold and applySync return a
 * fresh view every time, and the keyed transcript relies on the identity of
 * untouched Line objects surviving, which a deep proxy would not preserve.
 */

import type { ThreadId, ThreadSummary } from "../shared/protocol";
import type { HelmClient } from "./api";
import { addPendingPrompt, applySync, emptyView, fold, type ThreadView } from "./fold";
import { uuid } from "./format";
import { LABEL } from "./label";

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export type Conn = "connecting" | "replaying" | "live" | "offline";

export class ThreadSession {
  declare view: ThreadView;
  declare conn: Conn;
  declare summary: ThreadSummary;
  declare attachments: { uploadId: string; name: string }[];
  /** The last send or upload failure, shown above the composer until dismissed. */
  declare error: string | null;

  readonly #api: HelmClient;
  readonly #threadId: ThreadId;
  readonly #detach: () => void;

  constructor(api: HelmClient, threadId: ThreadId, summary: ThreadSummary) {
    this.view = $state.raw(emptyView(threadId));
    this.conn = $state<Conn>("connecting");
    this.summary = $state.raw(summary);
    this.attachments = $state([]);
    this.error = $state<string | null>(null);
    this.#api = api;
    this.#threadId = threadId;
    this.#detach = api.attach(threadId, 0, {
      onEvent: (ev) => {
        this.view = fold(this.view, ev);
        if (ev.kind === "thread.config") this.summary = { ...this.summary, config: { ...this.summary.config, ...ev.patch } };
        if (ev.kind === "turn.ended" && !this.view.replaying) void api.getThread(threadId).then((s) => (this.summary = s), () => null);
      },
      onSync: (frame) => {
        this.view = applySync(this.view, frame);
      },
      onState: (s) => {
        this.conn = s;
      },
    });
  }

  get running(): boolean {
    return this.view.openTurn !== null || this.view.session === "running" || this.view.session === "warming";
  }

  async submit(text: string, uploadIds: string[]): Promise<void> {
    const clientMsgId = uuid();
    this.view = addPendingPrompt(this.view, clientMsgId, text, LABEL);
    try {
      await this.#api.send(this.#threadId, { clientMsgId, text, uploadIds });
      this.error = null;
    } catch (err) {
      this.error = `Send failed: ${message(err)}`;
    }
  }

  async upload(files: readonly File[]): Promise<void> {
    try {
      const staged = await this.#api.upload(this.#threadId, files);
      this.attachments = [...this.attachments, ...staged.map((s) => ({ uploadId: s.uploadId, name: s.name }))];
      this.error = null;
    } catch (err) {
      this.error = `Upload failed: ${message(err)}`;
    }
  }

  interrupt(): void {
    void this.#api.interrupt(this.#threadId);
  }

  stop(): void {
    this.#detach();
  }
}
