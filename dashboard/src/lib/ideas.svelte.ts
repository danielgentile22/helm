import {
  fetchJson,
  type Failure,
  type Idea,
  type IdeaDraft,
  type IdeaStatus,
  type IdeaChange,
  type IdeaWrite,
  type Project,
  type PromoteBody,
  type PromoteWrite,
} from "./api";
import { localDate } from "./time";

type Edit = Partial<Pick<Idea, "status" | "due" | "title" | "notes" | "project">>;

export interface Toast {
  key: number;
  text: string;
  undo?: () => void;
  link?: string;
}

/** Where an idea of this project can be promoted to, or null when it has no tracker. */
export type PromoteTarget = { tracker: "github"; repos: string[] } | { tracker: "scratch" };

export function promoteTarget(project: Pick<Project, "tracker" | "repos">): PromoteTarget | null {
  if (project.tracker === "scratch") return { tracker: "scratch" };
  if (project.tracker === "none") return null;
  const repos = project.repos.flatMap((r) => (r.github === null ? [] : [r.github]));
  return repos.length === 0 ? null : { tracker: "github", repos };
}

export type PromoteResult = { kind: "done" } | { kind: "confirm"; repo: string } | { kind: "failed" };

export function isUrl(issue: string): boolean {
  return /^https?:\/\//.test(issue);
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

  function showToast(text: string, act: Pick<Toast, "undo" | "link">): void {
    clearTimeout(toastTimer);
    const key = ++seq;
    toast = { key, text, ...act };
    toastTimer = setTimeout(() => {
      if (toast?.key === key) toast = null;
    }, TOAST_MS);
  }

  function dismissToast(): void {
    clearTimeout(toastTimer);
    toast = null;
  }

  async function write(idea: Idea, field: "status" | "due" | "edit", edit: Edit): Promise<boolean> {
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
      showToast(status === "done" ? "Marked done" : "Dropped", {
        undo: () => {
          dismissToast();
          void write(idea, "status", { status: before });
        },
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
          notes: null,
        },
        ...adding,
      ];
      const answer = await fetchJson<IdeaWrite>("/api/ideas", draft);
      if (answer.state === "ready") await host.refresh();
      adding = adding.filter((i) => i.id !== id);
      return answer.state === "ready" ? null : failed(answer);
    },
    setStatus,
    /** Files the idea in its project's tracker. A repo someone else owns answers `confirm`
     *  until the owner says yes; then the same call again with `confirm: true`. */
    promote(idea: Idea, body: PromoteBody): Promise<PromoteResult> {
      delete errors[idea.id];
      return serial(idea.id, async () => {
        const answer = await fetchJson<PromoteWrite>(`/api/ideas/${encodeURIComponent(idea.id)}/promote`, body);
        if (answer.state === "ready") {
          const issue = answer.data.issue;
          showToast(isUrl(issue) ? "Promoted to an issue" : `Promoted to ${issue}`, isUrl(issue) ? { link: issue } : {});
          await host.refresh();
          return { kind: "done" };
        }
        const said = answer.body as { needs_confirm?: boolean; repo?: string } | undefined;
        if (answer.status === 409 && said?.needs_confirm === true && typeof said.repo === "string") {
          return { kind: "confirm", repo: said.repo };
        }
        errors[idea.id] = failed(answer);
        return { kind: "failed" };
      });
    },
    setDue(idea: Idea, due: string | null): Promise<boolean> {
      return write(idea, "due", { due });
    },
    /** Resolves true once the edited idea is on screen; a failure is named on the row. */
    edit(idea: Idea, change: IdeaChange): Promise<boolean> {
      return write(idea, "edit", change);
    },
  };
}

export type IdeaWrites = ReturnType<typeof createIdeaWrites>;
