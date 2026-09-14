/**
 * Client contract over the HTTP surface. No rendering here. attach() owns
 * the reconnect loop; every other method is one fetch.
 *
 * Reconnect rule: on any error, close, or seq violation (a gap or a
 * duplicate), reopen with `after = lastSeqSeen` and the generation it was
 * seen in. The generation is learned from the log itself: seq 1 is
 * `log.generation` in a compacted log and anything else in generation 0. A
 * sync frame whose head is behind the cursor, or whose generation is not the
 * one the cursor counts in (the log was compacted, even mid-replay), means
 * the phone's fold no longer describes the server's log: tell the handlers
 * to reset and reopen from zero in the frame's generation. This loop is the
 * only place that cursor rule lives.
 *
 * Backoff 500 ms -> 5 s. On `visibilitychange` to visible, reopen
 * immediately (iOS suspends EventSource in the background; the cursor makes
 * that harmless).
 */

import type {
  AskAnswer,
  AskId,
  CreateThreadRequest,
  Cursor,
  DirEntry,
  ForkRequest,
  Generation,
  HelmSettings,
  ModelChoice,
  SearchHit,
  SendRequest,
  SendResponse,
  SettingsPatch,
  SlashCommand,
  StagedUpload,
  SyncFrame,
  ThreadConfig,
  ThreadConfigPatch,
  ThreadEvent,
  ThreadId,
  ThreadSummary,
  TurnId,
  UploadId,
} from "../shared/protocol";
import { FIRST_GENERATION } from "../shared/protocol";

export type ConnState = "connecting" | "replaying" | "live" | "offline";

export interface AttachHandlers {
  onEvent(ev: ThreadEvent): void;
  onSync(frame: SyncFrame): void;
  /** The server's log is shorter than what was folded, or in another generation: discard it all, a replay from zero follows. */
  onReset(frame: SyncFrame): void;
  onState(state: ConnState): void;
}

/** The subset of EventSource the attach loop uses; injectable for tests. */
export interface EventSourceLike {
  onopen: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: string; lastEventId: string }) => void) | null;
  addEventListener(type: string, listener: (ev: { data: string }) => void): void;
  close(): void;
}

export interface ClientOptions {
  readonly baseUrl: string;
  readonly label?: string;
  readonly fetch?: typeof fetch;
  readonly EventSource?: new (url: string) => EventSourceLike;
  readonly document?: { visibilityState: string; addEventListener(type: string, l: () => void): void; removeEventListener(type: string, l: () => void): void };
  readonly minBackoffMs?: number;
  readonly maxBackoffMs?: number;
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export class HelmClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: ClientOptions) {
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.opts.baseUrl}${path}`, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: "include",
    });
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!res.ok) {
      const msg = typeof parsed === "object" && parsed !== null && typeof (parsed as { error?: unknown }).error === "string" ? (parsed as { error: string }).error : `${res.status} ${res.statusText}`;
      throw new HttpError(res.status, msg);
    }
    return parsed as T;
  }

  me(): Promise<{ label: string; via: string }> {
    return this.call("GET", "/auth/me");
  }
  listModels(): Promise<readonly ModelChoice[]> {
    return this.call("GET", "/api/models");
  }
  getSettings(): Promise<HelmSettings> {
    return this.call("GET", "/api/settings");
  }
  patchSettings(patch: SettingsPatch): Promise<HelmSettings> {
    return this.call("PATCH", "/api/settings", patch);
  }
  listPasskeys(): Promise<readonly { label: string; createdAt: string }[]> {
    return this.call("GET", "/api/passkeys");
  }
  about(): Promise<{ version: string; host: string }> {
    return this.call("GET", "/api/about");
  }
  listThreads(includeArchived = false): Promise<readonly ThreadSummary[]> {
    return this.call("GET", includeArchived ? "/api/threads?archived=1" : "/api/threads");
  }
  /** Server-side search over prompts and replies; rows come back newest first. */
  searchThreads(query: string, includeArchived = false, limit = 20): Promise<readonly SearchHit[]> {
    const q = new URLSearchParams({ q: query, limit: String(limit) });
    if (includeArchived) q.set("archived", "1");
    return this.call("GET", `/api/threads/search?${q}`);
  }
  getThread(threadId: ThreadId): Promise<ThreadSummary> {
    return this.call("GET", `/api/threads/${threadId}`);
  }
  createThread(req: CreateThreadRequest): Promise<ThreadConfig> {
    return this.call("POST", "/api/threads", req);
  }
  patchThread(threadId: ThreadId, patch: ThreadConfigPatch): Promise<ThreadConfig> {
    return this.call("PATCH", `/api/threads/${threadId}`, patch);
  }
  /** Copies the thread up to and including `turnId` into a new one. 409 while that turn is still running, 404 when it is unknown. Two calls make two forks. */
  forkThread(threadId: ThreadId, turnId: TurnId): Promise<ThreadSummary> {
    const req: ForkRequest = { turnId };
    return this.call("POST", `/api/threads/${threadId}/fork`, req);
  }
  archiveThread(threadId: ThreadId): Promise<void> {
    return this.call("DELETE", `/api/threads/${threadId}`);
  }
  browseDirs(path?: string): Promise<readonly DirEntry[]> {
    return this.call("GET", path ? `/api/dirs?path=${encodeURIComponent(path)}` : "/api/dirs");
  }

  /** Idempotent on clientMsgId. Safe to retry after a dropped request. */
  send(threadId: ThreadId, req: SendRequest): Promise<SendResponse> {
    return this.call("POST", `/api/threads/${threadId}/send`, { ...req, label: req.label ?? this.opts.label });
  }
  interrupt(threadId: ThreadId): Promise<void> {
    return this.call("POST", `/api/threads/${threadId}/interrupt`);
  }

  /** 204 when the answer was appended. A 409 means the ask is no longer pending: another device answered it, or it expired. */
  answerAsk(threadId: ThreadId, askId: AskId, answer: AskAnswer): Promise<void> {
    return this.call("POST", `/api/threads/${threadId}/answer`, { askId, answer });
  }

  /** 503 while the agent is unreachable, which the composer treats as an empty list. */
  async listCommands(threadId: ThreadId): Promise<readonly SlashCommand[]> {
    const { commands } = await this.call<{ commands: readonly SlashCommand[] }>("GET", `/api/threads/${threadId}/commands`);
    return commands;
  }

  async reloadCommands(threadId: ThreadId): Promise<readonly SlashCommand[]> {
    const { commands } = await this.call<{ commands: readonly SlashCommand[] }>("POST", `/api/threads/${threadId}/commands/reload`);
    return commands;
  }

  /** Where staged bytes are served: the composer thumbnail and the sent prompt line share it. */
  uploadUrl(threadId: ThreadId, uploadId: UploadId): string {
    return `${this.opts.baseUrl}/api/threads/${threadId}/uploads/${uploadId}`;
  }

  /** Where a file the model offered is served; the card opens it in a tab when the share sheet is unavailable. */
  fileUrl(threadId: ThreadId, fileId: string): string {
    return `${this.opts.baseUrl}/api/threads/${threadId}/files/${fileId}`;
  }

  /**
   * Fetch an offered file as a Blob for the share sheet. `onProgress` gets
   * bytes so far; a 404 means the file is gone from the Mac.
   */
  async fetchFile(threadId: ThreadId, fileId: string, onProgress?: (bytes: number) => void): Promise<Blob> {
    const res = await this.fetchImpl(this.fileUrl(threadId, fileId), { credentials: "include" });
    if (!res.ok) throw new HttpError(res.status, res.status === 404 ? "the file is no longer on the Mac" : `download failed: ${await res.text()}`);
    const type = res.headers.get("content-type") ?? "application/octet-stream";
    if (!res.body || !onProgress) return new Blob([await res.arrayBuffer()], { type });
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.byteLength;
      onProgress(got);
    }
    return new Blob(chunks as BlobPart[], { type });
  }

  async upload(threadId: ThreadId, files: readonly File[]): Promise<readonly StagedUpload[]> {
    const out: StagedUpload[] = [];
    for (const f of files) {
      const res = await this.fetchImpl(`${this.opts.baseUrl}/api/threads/${threadId}/uploads`, {
        method: "POST",
        headers: { "content-type": f.type || "application/octet-stream", "content-length": String(f.size), "x-upload-name": encodeURIComponent(f.name) },
        body: f,
        credentials: "include",
      });
      if (!res.ok) throw new HttpError(res.status, `upload failed: ${await res.text()}`);
      out.push(...((await res.json()) as StagedUpload[]));
    }
    return out;
  }

  /**
   * Replay from `after`, then live. Returns a stop function. The handlers
   * see events in strictly increasing seq; the client enforces it by
   * reconnecting on violation (see fold.ts invariant).
   */
  attach(threadId: ThreadId, after: Cursor, handlers: AttachHandlers): () => void {
    const ES = this.opts.EventSource ?? (EventSource as unknown as new (url: string) => EventSourceLike);
    const doc = this.opts.document ?? (typeof document !== "undefined" ? document : undefined);
    const min = this.opts.minBackoffMs ?? 500;
    const max = this.opts.maxBackoffMs ?? 5000;
    let lastSeen: number = after;
    let generation: Generation | null = null;
    let backoff = min;
    let es: EventSourceLike | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const open = (): void => {
      if (stopped) return;
      handlers.onState(lastSeen === 0 ? "connecting" : "replaying");
      const src = new ES(`${this.opts.baseUrl}/api/threads/${threadId}/events?after=${lastSeen}${generation === null ? "" : `&gen=${generation}`}`);
      es = src;
      src.onopen = () => {
        backoff = min;
        handlers.onState("replaying");
      };
      src.onmessage = (m) => {
        const ev = JSON.parse(m.data) as ThreadEvent;
        if (ev.seq !== lastSeen + 1) {
          reconnect(0);
          return;
        }
        lastSeen = ev.seq;
        if (ev.seq === 1) generation = ev.kind === "log.generation" ? ev.generation : FIRST_GENERATION;
        handlers.onEvent(ev);
      };
      src.addEventListener("sync", (m) => {
        const frame = JSON.parse(m.data) as SyncFrame;
        const stale = lastSeen > 0 && (frame.headSeq < lastSeen || frame.generation !== generation);
        generation = frame.generation;
        if (stale) {
          lastSeen = 0;
          handlers.onReset(frame);
          reconnect(0);
          return;
        }
        handlers.onSync(frame);
        handlers.onState("live");
      });
      src.onerror = () => reconnect(backoff);
    };

    const reconnect = (delayMs: number): void => {
      if (stopped) return;
      es?.close();
      es = null;
      handlers.onState("offline");
      if (timer) clearTimeout(timer);
      timer = setTimeout(open, delayMs);
      backoff = Math.min(max, backoff * 2);
    };

    const onVisible = (): void => {
      if (doc?.visibilityState === "visible" && !stopped) {
        backoff = min;
        reconnect(0);
      }
    };
    doc?.addEventListener("visibilitychange", onVisible);
    open();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      es?.close();
      doc?.removeEventListener("visibilitychange", onVisible);
    };
  }

  /** Global thread-list stream; the client re-fetches listThreads() on each change. */
  attachGlobal(onChange: (threadId: ThreadId, ev: ThreadEvent) => void): () => void {
    const ES = this.opts.EventSource ?? (EventSource as unknown as new (url: string) => EventSourceLike);
    let es: EventSourceLike | null = null;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const open = (): void => {
      if (stopped) return;
      es = new ES(`${this.opts.baseUrl}/api/events`);
      es.onmessage = (m) => {
        const ev = JSON.parse(m.data) as ThreadEvent & { threadId: ThreadId };
        onChange(ev.threadId, ev);
      };
      es.onerror = () => {
        es?.close();
        timer = setTimeout(open, 2000);
      };
    };
    open();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      es?.close();
    };
  }

  pushPublicKey(): Promise<{ key: string }> {
    return this.call("GET", "/api/push/key");
  }
  pushSubscribe(subscription: unknown): Promise<void> {
    return this.call("POST", "/api/push/subscribe", { subscription });
  }
  pushUnsubscribe(endpoint: string): Promise<void> {
    return this.call("DELETE", "/api/push/subscribe", { endpoint });
  }

  // WebAuthn ceremonies; the browser-side calls to navigator.credentials live in app.ts.
  loginOptions(): Promise<{ challengeId: string; options: unknown }> {
    return this.call("POST", "/auth/webauthn/login/options", {});
  }
  loginVerify(challengeId: string, response: unknown): Promise<{ label: string }> {
    return this.call("POST", "/auth/webauthn/login/verify", { challengeId, response });
  }
  registerOptions(enrollToken: string, label: string): Promise<{ challengeId: string; options: unknown }> {
    return this.call("POST", `/auth/webauthn/register/options?enroll=${encodeURIComponent(enrollToken)}`, { label });
  }
  registerVerify(challengeId: string, response: unknown): Promise<{ credentialId: string }> {
    return this.call("POST", "/auth/webauthn/register/verify", { challengeId, response });
  }
  logout(): Promise<void> {
    return this.call("POST", "/auth/logout");
  }
}
