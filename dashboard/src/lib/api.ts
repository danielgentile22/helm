// The wire. Every response carries a Date header the clock takes its skew from, and every
// failure arrives as one shape, `{"error": {"code", "detail"}}` (ADR 0014).

import { clock } from "./clock.svelte";
import { action, isTurnPhase } from "./model/turn";
import { ms, todoId } from "./model/types";
import type { NewTodo } from "./model/capture";
import type { TodoPatch } from "./model/edit";
import type { Turn } from "./model/turn";
import type { TodoId } from "./model/types";

const BASE = "/api";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string;

  constructor(status: number, code: string, detail: string) {
    super(detail);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export type Fetched = { status: 200; body: unknown; etag: string | null } | { status: 304 };

/** The line the server reports is the rewritten markdown line, not its number. */
export type Toggled = { changed: boolean; commit: string | null; line: string | null };

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function noteDate(response: Response): void {
  const header = response.headers.get("Date");
  if (header === null) return;
  const at = Date.parse(header);
  if (!Number.isNaN(at)) clock.noteServerDate(ms(at));
}

async function failure(response: Response): Promise<ApiError> {
  const generic = new ApiError(
    response.status,
    `http_${response.status}`,
    response.statusText || "the request failed",
  );
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return generic;
  }
  if (!isObj(body)) return generic;
  const error = body["error"];
  if (!isObj(error)) return generic;
  const code = error["code"];
  const detail = error["detail"];
  if (typeof code !== "string" || typeof detail !== "string") return generic;
  return new ApiError(response.status, code, detail);
}

// Every fetch goes through here so a 401 anywhere sends the page back to the door. The
// door registers itself, since it imports this module and a cycle the other way would
// make the bundle's chunking a coin toss.
let expired: () => void = () => {};

export function onUnauthorized(handler: () => void): void {
  expired = handler;
}

async function send(input: string, init: RequestInit): Promise<Response> {
  const response = await fetch(input, init);
  noteDate(response);
  if (response.status === 401) expired();
  return response;
}

async function get(path: string, etag: string | null): Promise<Fetched> {
  const headers: Record<string, string> = {};
  if (etag !== null) headers["If-None-Match"] = etag;
  const response = await send(`${BASE}${path}`, { headers, cache: "no-store" });
  if (response.status === 304) return { status: 304 };
  if (!response.ok) throw await failure(response);
  const body: unknown = await response.json();
  return { status: 200, body, etag: response.headers.get("ETag") };
}

/** The door's own routes, outside /api. */
export async function postJson<T = unknown>(path: string, payload: unknown): Promise<T> {
  const response = await send(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw await failure(response);
  return (await response.json()) as T;
}

export type Me = { via: "loopback" | "tailnet"; authenticated: boolean; enrolled: boolean };

export async function getMe(): Promise<Me> {
  const response = await fetch("/auth/me", { cache: "no-store" });
  noteDate(response);
  if (!response.ok) throw await failure(response);
  const body: unknown = await response.json();
  if (!isObj(body) || typeof body["authenticated"] !== "boolean") {
    throw new ApiError(response.status, "bad_body", "the door answered with something other than a verdict");
  }
  return {
    via: body["via"] === "tailnet" ? "tailnet" : "loopback",
    authenticated: body["authenticated"],
    enrolled: body["enrolled"] === true,
  };
}

export function getAgenda(etag: string | null): Promise<Fetched> {
  return get("/agenda", etag);
}

export function getProjects(etag: string | null): Promise<Fetched> {
  return get("/projects", etag);
}

/** What POST /api/talk answers with once the clip is transcribed. The run itself is still
 *  going: `turn` is the id to poll. A 409 busy arrives as an ApiError like any other. */
export type Started = { turn: string; transcript: string; ack: string; ms: { stt: number } };

export async function postTalk(clip: Blob): Promise<Started> {
  // The clip goes up raw, so the server reads the codec off the content type the recorder
  // chose rather than a wrapper we would have to keep in step with it.
  const headers: Record<string, string> = {};
  if (clip.type !== "") headers["Content-Type"] = clip.type;
  const response = await send(`${BASE}/talk`, { method: "POST", headers, body: clip });
  if (!response.ok) throw await failure(response);
  const body: unknown = await response.json();
  if (!isObj(body)) {
    throw new ApiError(response.status, "bad_body", "the turn answered with something other than an object");
  }
  const turn = body["turn"];
  const transcript = body["transcript"];
  const ack = body["ack"];
  if (typeof turn !== "string" || typeof transcript !== "string" || typeof ack !== "string") {
    throw new ApiError(response.status, "bad_body", "the turn answered without an id, a transcript, and an ack");
  }
  const took = body["ms"];
  const stt = isObj(took) ? took["stt"] : null;
  return { turn, transcript, ack, ms: { stt: typeof stt === "number" ? stt : 0 } };
}

/** The turn file as the server wrote it. A row that does not match the contract fails the
 *  whole body rather than being dropped: a written row the dashboard never shows is worse
 *  than a visible failure. */
export function decodeTurn(body: unknown): Turn {
  const bad = (detail: string): ApiError => new ApiError(200, "bad_body", detail);
  if (!isObj(body)) throw bad("the turn came back as something other than an object");
  const id = body["id"];
  const transcript = body["transcript"];
  const ack = body["ack"];
  const phase = body["phase"];
  if (typeof id !== "string" || typeof transcript !== "string" || typeof ack !== "string") {
    throw bad("the turn came back without an id, a transcript, and an ack");
  }
  if (!isTurnPhase(phase)) throw bad("the turn came back in a phase that is not one of the five");
  const rows = body["actions"];
  if (!Array.isArray(rows)) throw bad("the turn came back without a list of actions");
  const actions = rows.map((row: unknown) => {
    const taken = action(row);
    if (taken === null) throw bad("the turn came back with an action that is not one");
    return taken;
  });
  const confirmation = body["confirmation"];
  const error = body["error"];
  return {
    id,
    transcript,
    ack,
    phase,
    confirmation: typeof confirmation === "string" ? confirmation : null,
    actions,
    error: typeof error === "string" ? error : null,
  };
}

export async function getTurn(id: string): Promise<Turn> {
  const response = await send(`${BASE}/turns/${encodeURIComponent(id)}`, { cache: "no-store" });
  if (!response.ok) throw await failure(response);
  return decodeTurn(await response.json());
}

export async function postCancelTurn(id: string): Promise<Turn> {
  const response = await send(`${BASE}/turns/${encodeURIComponent(id)}/cancel`, { method: "POST" });
  if (!response.ok) throw await failure(response);
  return decodeTurn(await response.json());
}

/** Resolves when the voice process is up and throws the usual ApiError when it is not. */
export async function getVoiceHealth(): Promise<void> {
  const response = await send(`${BASE}/voice/health`, { cache: "no-store" });
  if (!response.ok) throw await failure(response);
}

export function speakUrl(text: string): string {
  return `${BASE}/speak?text=${encodeURIComponent(text)}`;
}

/** The id is the todo's content id after the edit, which is a new one when the text changed. */
export type Edited = { id: TodoId; changed: boolean };

export async function patchTodo(id: TodoId, patch: TodoPatch): Promise<Edited> {
  const response = await send(`${BASE}/todos/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!response.ok) throw await failure(response);
  const body: unknown = await response.json();
  const next = isObj(body) ? body["id"] : null;
  if (typeof next !== "string") {
    throw new ApiError(response.status, "bad_body", "the edit answered without the todo's id");
  }
  return { id: todoId(next), changed: isObj(body) && body["changed"] === true };
}

/** Write a new todo on its department note. Resolves to the new todo's content id. */
export async function postTodo(todo: NewTodo): Promise<TodoId> {
  const response = await send(`${BASE}/todos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(todo),
  });
  if (!response.ok) throw await failure(response);
  const body: unknown = await response.json();
  const id = isObj(body) ? body["id"] : null;
  if (typeof id !== "string") {
    throw new ApiError(response.status, "bad_body", "the add answered without the todo's id");
  }
  return todoId(id);
}

/** `keepalive` lets the request outlive the page, for a tick flushed as the tab closes. */
export async function putTodoDone(id: TodoId, done: boolean, keepalive = false): Promise<Toggled> {
  const response = await send(`${BASE}/todos/${encodeURIComponent(id)}/done`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ done }),
    keepalive,
  });
  if (!response.ok) throw await failure(response);
  const body: unknown = await response.json();
  if (!isObj(body)) {
    throw new ApiError(response.status, "bad_body", "the toggle answered with something other than an object");
  }
  const commit = body["commit"];
  const line = body["line"];
  return {
    changed: body["changed"] === true,
    commit: typeof commit === "string" ? commit : null,
    line: typeof line === "string" ? line : null,
  };
}
