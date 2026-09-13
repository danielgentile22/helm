/**
 * Client contract over the HTTP surface. No rendering here. attach() owns
 * the reconnect loop; every other method is one fetch.
 *
 * Reconnect rule: on any error, close, or seq violation, reopen with
 * `after = lastSeqSeen`. Backoff 500 ms -> 5 s. On `visibilitychange` to
 * visible, reopen immediately (iOS suspends EventSource in the background;
 * the cursor makes that harmless).
 */

import type {
  CreateThreadRequest,
  Cursor,
  DirEntry,
  HelmSettings,
  ModelChoice,
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
  UploadId,
} from "../shared/protocol";

export interface AttachHandlers {
  onEvent(ev: ThreadEvent): void;
  onSync(frame: SyncFrame): void;
  onState(state: "connecting" | "replaying" | "live" | "offline"): void;
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
  getThread(threadId: ThreadId): Promise<ThreadSummary> {
    return this.call("GET", `/api/threads/${threadId}`);
  }
  createThread(req: CreateThreadRequest): Promise<ThreadConfig> {
    return this.call("POST", "/api/threads", req);
  }
  patchThread(threadId: ThreadId, patch: ThreadConfigPatch): Promise<ThreadConfig> {
    return this.call("PATCH", `/api/threads/${threadId}`, patch);
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
    let backoff = min;
    let es: EventSourceLike | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const open = (): void => {
      if (stopped) return;
      handlers.onState(lastSeen === 0 ? "connecting" : "replaying");
      const src = new ES(`${this.opts.baseUrl}/api/threads/${threadId}/events?after=${lastSeen}`);
      es = src;
      src.onopen = () => {
        backoff = min;
        handlers.onState("replaying");
      };
      src.onmessage = (m) => {
        const ev = JSON.parse(m.data) as ThreadEvent;
        if (ev.seq !== lastSeen + 1) {
          // Gap or duplicate: drop the connection and re-attach from what we have.
          reconnect(0);
          return;
        }
        lastSeen = ev.seq;
        handlers.onEvent(ev);
      };
      src.addEventListener("sync", (m) => {
        const frame = JSON.parse(m.data) as SyncFrame;
        if (frame.headSeq < lastSeen) {
          // The server's log is shorter than what we have folded: start over.
          lastSeen = 0;
          handlers.onSync(frame);
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
