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
  SendRequest,
  SendResponse,
  StagedUpload,
  SyncFrame,
  ThreadConfig,
  ThreadConfigPatch,
  ThreadEvent,
  ThreadId,
  ThreadSummary,
} from "../shared/protocol";

export interface AttachHandlers {
  onEvent(ev: ThreadEvent): void;
  onSync(frame: SyncFrame): void;
  onState(state: "connecting" | "replaying" | "live" | "offline"): void;
}

export class HelmClient {
  constructor(private readonly opts: { baseUrl: string; label?: string }) {}

  listThreads(): Promise<readonly ThreadSummary[]> {
    throw new Error("not implemented");
  }
  createThread(req: CreateThreadRequest): Promise<ThreadConfig> {
    throw new Error("not implemented");
  }
  patchThread(threadId: ThreadId, patch: ThreadConfigPatch): Promise<ThreadConfig> {
    throw new Error("not implemented");
  }
  archiveThread(threadId: ThreadId): Promise<void> {
    throw new Error("not implemented");
  }
  browseDirs(path: string): Promise<readonly DirEntry[]> {
    throw new Error("not implemented");
  }

  /** Idempotent on clientMsgId. Safe to retry after a dropped request. */
  send(threadId: ThreadId, req: SendRequest): Promise<SendResponse> {
    throw new Error("not implemented");
  }
  interrupt(threadId: ThreadId): Promise<void> {
    throw new Error("not implemented");
  }
  upload(threadId: ThreadId, files: readonly File[]): Promise<readonly StagedUpload[]> {
    throw new Error("not implemented");
  }

  /**
   * Replay from `after`, then live. Returns a stop function. The handlers
   * see events in strictly increasing seq; the client enforces it by
   * reconnecting on violation (see fold.ts invariant).
   */
  attach(threadId: ThreadId, after: Cursor, handlers: AttachHandlers): () => void {
    throw new Error("not implemented");
  }

  /** Global thread-list stream; the client re-fetches listThreads() on each reconnect. */
  attachGlobal(onChange: (threadId: ThreadId, ev: ThreadEvent) => void): () => void {
    throw new Error("not implemented");
  }

  pushPublicKey(): Promise<string> {
    throw new Error("not implemented");
  }
  pushSubscribe(sub: PushSubscriptionJSON, label: string): Promise<void> {
    throw new Error("not implemented");
  }
}

/**
 * WebAuthn on the client. Cold open: if no valid cookie (any 401), run the
 * assertion ceremony (Face ID), then continue. The cookie does the rest.
 */
export async function ensureSignedIn(baseUrl: string): Promise<void> {
  throw new Error("not implemented");
}
