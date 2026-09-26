"use client";

import { useCallback, useEffect, useState } from "react";
import { helmKey } from "@/lib/helmKey";
import { SectionTitle } from "./util";

interface Item {
  index: number;
  text: string;
  done: boolean;
  section: string;
}

// Job-search TODO list — reads/writes <vault>/jobs/todos.md via /api/todos.
// Native checkboxes toggle in place; the input appends a new item (it lands
// under the file's trailing "## Inbox" section). Obsidian edits the same
// file, so a 409/failed write means "refetch truth", never "retry blind".
export default function JobTodos() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const refresh = useCallback(() => {
    fetch("/api/todos", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then((j: { items: Item[] }) => setItems(j.items))
      .catch(() => setFlash("todos unavailable"));
  }, []);
  useEffect(refresh, [refresh]);

  const post = async (payload: Record<string, unknown>): Promise<boolean> => {
    try {
      const r = await fetch("/api/todos", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-HELM-KEY": await helmKey() },
        body: JSON.stringify(payload),
      });
      return r.ok;
    } catch {
      return false;
    }
  };

  const toggle = async (it: Item) => {
    setItems((cur) => cur?.map((x) => (x.index === it.index ? { ...x, done: !it.done } : x)) ?? null);
    const ok = await post({ action: "toggle", index: it.index, text: it.text, done: !it.done });
    if (!ok) refresh();
  };

  const add = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    const ok = await post({ action: "add", text: t });
    setBusy(false);
    if (ok) {
      setText("");
      refresh();
    } else {
      setFlash("add failed");
      setTimeout(() => setFlash(null), 4000);
    }
  };

  // preserve file order, group consecutive items under their ## heading
  const sections: { name: string; items: Item[] }[] = [];
  for (const it of items ?? []) {
    const last = sections[sections.length - 1];
    if (last && last.name === it.section) last.items.push(it);
    else sections.push({ name: it.section, items: [it] });
  }
  const open = items?.filter((i) => !i.done).length ?? 0;

  return (
    <section className="panel">
      <SectionTitle title="TODOs" tick={items ? `${open} OPEN` : "…"} />
      {items === null ? (
        <div className="tab-sub">{flash ?? "loading…"}</div>
      ) : (
        <div className="todo-list">
          {items.length === 0 && <div className="tab-sub">Nothing yet — add the first one below.</div>}
          {sections.map((s, si) => (
            <div key={si}>
              {s.name && <div className="todo-sec">{s.name}</div>}
              {s.items.map((it) => (
                <label key={it.index} className={`todo-item${it.done ? " done" : ""}`}>
                  <input type="checkbox" checked={it.done} onChange={() => toggle(it)} />
                  <span>{it.text}</span>
                </label>
              ))}
            </div>
          ))}
        </div>
      )}
      <div className="ta-row">
        <input
          className="ta-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
          placeholder="New TODO…"
          aria-label="new todo"
        />
        <button className="btn btn-primary" onClick={add} disabled={!text.trim() || busy}>
          Add
        </button>
      </div>
      {flash && items !== null && <div className="ta-flash">{flash}</div>}
    </section>
  );
}
