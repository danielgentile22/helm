import { NextResponse } from "next/server";
import { bodyTooLarge, checkHelmKey } from "@/lib/auth";
import {
  TODOS_REL,
  addTodo,
  cleanTodoText,
  parseTodos,
  readTodosFile,
  toggleTodo,
  writeTodosFile,
} from "@/lib/todos";

// ---------------------------------------------------------------------------
// GET  /api/todos                          — parsed items from jobs/todos.md
// POST /api/todos {action:"add", text}     — append an open item
// POST /api/todos {action:"toggle", index, text, done} — check/uncheck
// Fixed vault path — no user-supplied path, so no traversal surface (unlike
// /api/report). Writes require X-HELM-KEY like every state-changing route;
// CHAT_ONLY middleware already 404s this on the Fly VM.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

export async function GET() {
  const md = readTodosFile();
  return NextResponse.json({ path: TODOS_REL, items: md ? parseTodos(md) : [] });
}

export async function POST(req: Request) {
  const key = checkHelmKey(req.headers.get("x-helm-key"));
  if (!key.ok) return NextResponse.json({ error: key.error }, { status: key.status });
  if (bodyTooLarge(req, 16 * 1024)) {
    return NextResponse.json({ error: "body too large" }, { status: 413 });
  }

  let body: { action?: unknown; text?: unknown; index?: unknown; done?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  try {
    if (body.action === "add") {
      const text = cleanTodoText(body.text);
      if (!text) return NextResponse.json({ error: "text required" }, { status: 400 });
      writeTodosFile(addTodo(readTodosFile() ?? "# Job TODOs\n", text));
      return NextResponse.json({ ok: true });
    }
    if (body.action === "toggle") {
      const md = readTodosFile();
      const index = Number(body.index);
      if (!md || !Number.isInteger(index)) {
        return NextResponse.json({ error: "bad toggle" }, { status: 400 });
      }
      const next = toggleTodo(md, index, String(body.text ?? ""), Boolean(body.done));
      if (next === null) {
        // file changed under us (Obsidian edit) — client refetches
        return NextResponse.json({ error: "todo moved — refresh" }, { status: 409 });
      }
      writeTodosFile(next);
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch (e) {
    console.error("[/api/todos]", e); // detail stays server-side — String(e) leaks vault paths
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
