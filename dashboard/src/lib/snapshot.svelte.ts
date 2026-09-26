// The decoded model the whole app reads, plus the optimistic overlay for the one write.
// The overlay expires by the agenda's own `produced`, so the file is always the authority
// and a lost response cannot leave a todo hidden forever.

import { ApiError, getAgenda, getProjects, patchTodo, postTodo, putTodoDone } from "./api";
import type { NewTodo } from "./model/capture";
import type { TodoPatch } from "./model/edit";
import { clock } from "./clock.svelte";
import { decode } from "./model/decode";
import { ms } from "./model/types";
import type { Model, Ms, TodoId } from "./model/types";

const POLL_MS = 60_000;

type Pending = { done: boolean; at: Ms };

let base = $state<Model | null>(null);
let pending = $state<Record<string, Pending>>({});
let error = $state<string | null>(null);

let agendaEtag: string | null = null;
let projectsEtag: string | null = null;
let agendaBody: unknown = null;
let projectsBody: unknown = null;

// The file's `produced` is the newest of its sources', and the todos source stamps itself
// when the re-merge reruns it, so an agenda produced at or after the click already carries
// the toggle. Strictly older means the file has not caught up yet and the overlay holds.
function stillPending(entry: Pending, produced: Ms | null): boolean {
  return produced === null || produced < entry.at;
}

function withOverlay(model: Model): Model {
  const hidden = new Set(
    Object.entries(pending)
      .filter(([, entry]) => entry.done && stillPending(entry, model.produced.agenda))
      .map(([id]) => id),
  );
  if (hidden.size === 0) return model;
  return { ...model, things: model.things.filter((thing) => thing.kind !== "todo" || !hidden.has(thing.todoId)) };
}

const view = $derived(base === null ? null : withOverlay(base));

function reason(cause: unknown): string {
  if (cause instanceof ApiError) return cause.detail;
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

function forget(id: TodoId): void {
  const next = { ...pending };
  delete next[id];
  pending = next;
}

// The two documents are fetched together but settled apart: one of them being unreadable,
// which is what a capture that has never run looks like, must not blank the panels that the
// other one feeds. decode() takes null for either side.
async function refresh(): Promise<void> {
  const [agenda, projects] = await Promise.allSettled([
    getAgenda(agendaEtag),
    getProjects(projectsEtag),
  ]);
  let changed = false;
  if (agenda.status === "fulfilled" && agenda.value.status === 200) {
    agendaBody = agenda.value.body;
    agendaEtag = agenda.value.etag;
    changed = true;
  }
  if (projects.status === "fulfilled" && projects.value.status === 200) {
    projectsBody = projects.value.body;
    projectsEtag = projects.value.etag;
    changed = true;
  }
  if (changed) base = decode(agendaBody, projectsBody);
  const model = base;
  if (model !== null) {
    pending = Object.fromEntries(
      Object.entries(pending).filter(([, entry]) => stillPending(entry, model.produced.agenda)),
    );
  }
  const reasons: string[] = [];
  if (agenda.status === "rejected") reasons.push(`agenda: ${reason(agenda.reason)}`);
  if (projects.status === "rejected") reasons.push(`projects: ${reason(projects.reason)}`);
  error = reasons.length === 0 ? null : reasons.join(", ");
}

async function toggleTodo(id: TodoId, done: boolean, keepalive = false): Promise<void> {
  // Truncated to the second, because every stamp the producers write is. Without this a
  // click at .400 would never match a merge stamped on the same second and the overlay
  // would hold until the next capture.
  const at = ms(Math.floor(clock.now() / 1000) * 1000);
  pending = { ...pending, [id]: { done, at } };
  try {
    await putTodoDone(id, done, keepalive);
  } catch (cause) {
    forget(id);
    error = reason(cause);
    return;
  }
  await refresh();
}

/** Rewrite a todo and wait for agenda.json to carry it. Resolves to the todo's id after the
 *  edit, or rejects with the server's reason, which the form shows where it was typed. */
async function editTodo(id: TodoId, patch: TodoPatch): Promise<TodoId> {
  const edited = await patchTodo(id, patch);
  if (edited.changed) await refresh();
  return edited.id;
}

/** Write a new todo and wait for agenda.json to carry it. Resolves to its id, or rejects
 *  with the server's reason, which the quick add field shows where it was typed. */
async function addTodo(todo: NewTodo): Promise<TodoId> {
  const id = await postTodo(todo);
  await refresh();
  return id;
}

export const snapshot = {
  get model(): Model | null {
    return view;
  },
  /** Whether a tick for this row is still in flight. A todo row is only ever an open box:
   *  a ticked one leaves agenda.json on the re-merge, so the checkbox is drawn from this
   *  rather than left to the DOM, and a failed PUT unticks it in front of the person. */
  pendingDone(id: TodoId): boolean {
    return pending[id]?.done === true;
  },
  get error(): string | null {
    return error;
  },
  refresh,
  toggleTodo,
  editTodo,
  addTodo,
  start(): () => void {
    const poll = (): void => {
      if (!document.hidden) void refresh();
    };
    void refresh();
    const timer = setInterval(poll, POLL_MS);
    document.addEventListener("visibilitychange", poll);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  },
};
