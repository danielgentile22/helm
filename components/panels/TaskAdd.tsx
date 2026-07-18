"use client";

import { useState } from "react";
import { useShell } from "@/components/shell/ShellContext";
import { SectionTitle } from "./util";

// client-side, so NEXT_PUBLIC_ (inlined at build) — keep in step with
// HUD_COLLABORATOR_NAME, which is what the runner and router use server-side.
const COLLABORATOR = process.env.NEXT_PUBLIC_COLLABORATOR_NAME || "Collaborator";
const ASSIGNEES = ["Daniel", COLLABORATOR, "Both", "Unassigned"];
const PRIORITIES = ["High", "Med", "Low"];

// Jot a Morphy task — the one action available on phone (and a desktop
// affordance). Queues morphy-task-add with {title, assignee, priority}; the
// runner creates the card on the Notion board and re-syncs.
export default function TaskAdd() {
  const { queueSkill } = useShell();
  const [title, setTitle] = useState("");
  const [assignee, setAssignee] = useState("Daniel");
  const [priority, setPriority] = useState("Med");
  const [flash, setFlash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const t = title.trim();
    if (!t || busy) return;
    setBusy(true);
    const ok = await queueSkill("morphy-task-add", { title: t, assignee, priority });
    setBusy(false);
    if (ok) {
      setTitle("");
      setFlash(`queued · ${t.slice(0, 40)}`);
      setTimeout(() => setFlash(null), 4000);
    } else {
      setFlash("queue write failed");
    }
  };

  return (
    <section className="panel">
      <SectionTitle title="Add Task" tick="→ MORPHY BOARD" />
      <input
        className="ta-input"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
        placeholder="What needs doing?"
        aria-label="task title"
      />
      <div className="ta-row">
        <select className="ta-select" value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label="assignee">
          {ASSIGNEES.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <select className="ta-select" value={priority} onChange={(e) => setPriority(e.target.value)} aria-label="priority">
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <button className="btn btn-primary" onClick={submit} disabled={!title.trim() || busy}>
          Add
        </button>
      </div>
      {flash && <div className="ta-flash">{flash}</div>}
    </section>
  );
}
