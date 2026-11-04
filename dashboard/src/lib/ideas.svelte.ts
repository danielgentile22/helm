import { fetchJson, type Failure, type Idea, type IdeaDraft, type IdeaStatus, type IdeaWrite } from "./api";
import { localDate } from "./time";

type Edit = Partial<Pick<Idea, "status" | "due">>;

export interface Toast {
  key: number;
  text: string;
  undo: () => void;
}

export interface IdeaHost {
  /** Refetch the list the ideas came from; resolves once the new answer is on screen. */
  refresh: () => Promise<void>;
  signedOut: (failure: Failure) => void;
}

const TOAST_MS = 6000;

/**
 * The writes one idea list makes, drawn before the server answers. An add shows as a pending
 * row, and an edit shows on its row, until the refetch after the write is on screen; a failed
 * write drops back to what the server holds and names why on the row or in the box.
 * Writes to one idea run one after another, so an undo never overtakes the change it undoes.
 */
export function createIdeaWrites(host: IdeaHost) {
  let adding = $state<Idea[]>([]);
  let edits = $state<Record<string, { edit: Edit; token: number }>>({});
  let errors = $state<Record<string, string>>({});
  let toast = $state<Toast | null>(null);
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  let seq = 0;
  const chains = new Map<string, Promise<unknown>>();

  function serial<T>(id: string, run: () => Promise<T>): Promise<T> {
    const next = (chains.get(id) ?? Promise.resolve()).then(run, run);
    chains.set(id, next);
    return next;
  }

  function failed(failure: Failure): string {
    if (failure.kind === "unauthorized") host.signedOut(failure);
    return failure.detail;
  }

  function showToast(text: string, undo: () => void): void {
    clearTimeout(toastTimer);
    const key = ++seq;
    toast = { key, text, undo };
    toastTimer = setTimeout(() => {
      if (toast?.key === key) toast = null;
    }, TOAST_MS);
  }

  function dismissToast(): void {
    clearTimeout(toastTimer);
    toast = null;
  }

  async function write(idea: Idea, field: "status" | "due", edit: Edit): Promise<boolean> {
    const token = ++seq;
    edits[idea.id] = { edit: { ...edits[idea.id]?.edit, ...edit }, token };
    delete errors[idea.id];
    return serial(idea.id, async () => {
      const answer = await fetchJson<IdeaWrite>(`/api/ideas/${encodeURIComponent(idea.id)}/${field}`, edit);
      if (answer.state === "ready") await host.refresh();
      else errors[idea.id] = failed(answer);
      if (edits[idea.id]?.token === token) delete edits[idea.id];
      return answer.state === "ready";
    });
  }

  async function setStatus(idea: Idea, status: IdeaStatus): Promise<void> {
    const before = idea.status;
    const undoable = status === "done" || status === "dropped";
    if (undoable) {
      showToast(status === "done" ? "Marked done" : "Dropped", () => {
        dismissToast();
        void write(idea, "status", { status: before });
      });
    }
    const ok = await write(idea, "status", { status });
    if (!ok && undoable) dismissToast();
  }

  return {
    get toast() {
      return toast;
    },
    dismissToast,
    errorOf(id: string): string | null {
      return errors[id] ?? null;
    },
    /** The server's ideas with every write in flight drawn over them, pending adds first. */
    view(server: Idea[], show: (idea: Idea) => boolean): Idea[] {
      const edited = server.map((i) => (edits[i.id] === undefined ? i : { ...i, ...edits[i.id]!.edit }));
      return [...adding, ...edited].filter(show);
    },
    isPending(idea: Idea): boolean {
      return adding.some((i) => i.id === idea.id);
    },
    /** Resolves to null once the new idea is on screen, else why it was not added. */
    async add(draft: IdeaDraft): Promise<string | null> {
      const id = `pending-${++seq}`;
      adding = [
        {
          id,
          path: "",
          title: draft.title.trim().replace(/\s+/g, " "),
          created: localDate(Date.now()),
          status: "open",
          department: "Life",
          project: draft.project,
          due: draft.due,
          issue: null,
        },
        ...adding,
      ];
      const answer = await fetchJson<IdeaWrite>("/api/ideas", draft);
      if (answer.state === "ready") await host.refresh();
      adding = adding.filter((i) => i.id !== id);
      return answer.state === "ready" ? null : failed(answer);
    },
    setStatus,
    setDue(idea: Idea, due: string | null): Promise<boolean> {
      return write(idea, "due", { due });
    },
  };
}

export type IdeaWrites = ReturnType<typeof createIdeaWrites>;
