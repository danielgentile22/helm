/**
 * One open thread: the pure fold wired to the attach loop, plus the composer's
 * attachments, the slash command list and the last failure. Everything the
 * screen shows about the thread is in one immutable ThreadState, replaced
 * whole on every change through the cell the caller hands in. The Svelte
 * shell (thread.svelte.ts) gives it a reactive cell; tests give it a plain one.
 *
 * `view` changes by replacement because fold and applySync return a fresh view
 * every time, and the keyed transcript relies on untouched Line objects keeping
 * their identity, which a deep proxy would not preserve.
 */

import type { AskAnswer, AskId, SlashCommand, ThreadConfig, ThreadId, ThreadSummary } from "../shared/protocol";
import { HttpError, type ConnState, type HelmClient } from "./api";
import { addPendingPrompt, applySync, emptyView, fold, type PromptUpload, type ThreadView } from "./fold";
import { uuid } from "./format";

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export interface ThreadState {
  readonly view: ThreadView;
  readonly conn: ConnState;
  readonly attachments: readonly PromptUpload[];
  /** Fetched once when the thread opens; empty while the agent is unreachable. */
  readonly commands: readonly SlashCommand[];
  readonly commandsError: string | null;
  /** The last send or upload failure, shown above the composer until dismissed. */
  readonly error: string | null;
}

/** Where the state lives; the session only ever reads and replaces it whole. */
export interface StateCell {
  get(): ThreadState;
  set(next: ThreadState): void;
}

export type SessionApi = Pick<HelmClient, "attach" | "send" | "upload" | "interrupt" | "listCommands" | "reloadCommands" | "answerAsk">;

/** The summary is the seed: its config and head stand in until the replay from zero has caught up. */
export function initialState(summary: ThreadSummary): ThreadState {
  return { view: emptyView(summary.config, summary.headSeq), conn: "connecting", attachments: [], commands: [], commandsError: null, error: null };
}

export class ThreadSession {
  readonly #api: SessionApi;
  readonly #threadId: ThreadId;
  readonly #label: string;
  readonly #cell: StateCell;
  readonly #detach: () => void;

  constructor(api: SessionApi, threadId: ThreadId, label: string, cell: StateCell) {
    this.#api = api;
    this.#threadId = threadId;
    this.#label = label;
    this.#cell = cell;
    this.#detach = api.attach(threadId, 0, {
      onEvent: (ev) => this.#patch({ view: fold(this.view, ev) }),
      onSync: (frame) => this.#patch({ view: applySync(this.view, frame) }),
      onReset: (frame) => this.#patch({ view: { ...emptyView(this.view.config, frame.headSeq), session: frame.session } }),
      onState: (conn) => this.#patch({ conn }),
    });
    void this.loadCommands();
  }

  get state(): ThreadState {
    return this.#cell.get();
  }
  get view(): ThreadView {
    return this.state.view;
  }
  get config(): ThreadConfig {
    return this.state.view.config;
  }
  get conn(): ConnState {
    return this.state.conn;
  }
  get attachments(): readonly PromptUpload[] {
    return this.state.attachments;
  }
  set attachments(next: readonly PromptUpload[]) {
    this.#patch({ attachments: next });
  }
  get commands(): readonly SlashCommand[] {
    return this.state.commands;
  }
  get commandsError(): string | null {
    return this.state.commandsError;
  }
  get error(): string | null {
    return this.state.error;
  }
  set error(next: string | null) {
    this.#patch({ error: next });
  }

  get running(): boolean {
    return this.view.openTurn !== null || this.view.session === "running" || this.view.session === "warming";
  }

  #patch(part: Partial<ThreadState>): void {
    this.#cell.set({ ...this.state, ...part });
  }

  async submit(text: string, uploads: readonly PromptUpload[]): Promise<void> {
    const clientMsgId = uuid();
    this.#patch({ view: addPendingPrompt(this.view, clientMsgId, text, this.#label, uploads) });
    try {
      await this.#api.send(this.#threadId, { clientMsgId, text, uploadIds: uploads.map((u) => u.uploadId) });
      this.error = null;
    } catch (err) {
      this.error = `Send failed: ${message(err)}`;
    }
  }

  async upload(files: readonly File[]): Promise<void> {
    try {
      const staged = await this.#api.upload(this.#threadId, files);
      this.#patch({ attachments: [...this.attachments, ...staged.map((s) => ({ uploadId: s.uploadId, name: s.name, mime: s.mime }))], error: null });
    } catch (err) {
      this.error = `Upload failed: ${message(err)}`;
    }
  }

  /** A 503 leaves the list empty and records why; the composer stays usable either way. */
  async loadCommands(reload = false): Promise<void> {
    try {
      const commands = reload ? await this.#api.reloadCommands(this.#threadId) : await this.#api.listCommands(this.#threadId);
      this.#patch({ commands, commandsError: null });
    } catch (err) {
      this.#patch({ commandsError: message(err) });
    }
  }

  /**
   * A 409 records nothing: the ask was already settled elsewhere, and the
   * `ask.answered` event on its way replaces the card with the answered form.
   * The card shows "Answered elsewhere" meanwhile, from its own local flag.
   */
  async answer(askId: AskId, answer: AskAnswer): Promise<void> {
    try {
      await this.#api.answerAsk(this.#threadId, askId, answer);
      this.error = null;
    } catch (err) {
      if (err instanceof HttpError && err.status === 409) throw err;
      this.error = `Answer failed: ${message(err)}`;
      throw err;
    }
  }

  interrupt(): void {
    void this.#api.interrupt(this.#threadId);
  }

  stop(): void {
    this.#detach();
  }
}
