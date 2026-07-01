"use client";

import { useEffect, useState } from "react";
import { useShell } from "@/components/shell/ShellContext";
import { noteAgeDays, SectionTitle } from "./util";

function useClock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function parseHHMM(t: string): number {
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : -1;
}

export default function Schedule() {
  const { state } = useShell();
  const now = useClock();
  const d = state?.daily;
  const a = state?.agenda;

  // agenda cache counts as "today's" only when its date is the local day
  const todayLocal = now ? new Intl.DateTimeFormat("en-CA").format(now) : null;
  const useAgenda = !!(a && a.ok && a.events.length > 0 && todayLocal && a.date === todayLocal);

  const items0: { time: string; item: string }[] = useAgenda
    ? a!.events.map((e) => ({ time: e.time, item: e.item }))
    : d?.schedule ?? [];
  if (items0.length === 0) return null;

  const live = useAgenda || (d?.isToday ?? false);
  const nowMin = now && live ? now.getHours() * 60 + now.getMinutes() : -1;
  const items = items0.map((s) => ({ ...s, min: parseHHMM(s.time) }));
  let currentIdx = -1;
  if (nowMin >= 0) {
    for (let i = 0; i < items.length; i++) if (items[i].min >= 0 && items[i].min <= nowMin) currentIdx = i;
  }
  const ageDays = live ? 0 : d ? noteAgeDays(d.date) : 0;
  const tick = useAgenda ? "TODAY · CAL" : d?.isToday ? "TODAY" : `${ageDays}D OLD`;

  return (
    <section className={`panel ${live ? "" : "note-stale"}`}>
      <SectionTitle title="Schedule" tick={tick} href="https://calendar.google.com/calendar/u/0/r/day" />
      <div className="sched">
        {items.map((s, i) => (
          <div
            key={`${s.time}-${i}`}
            className={`sched-row ${i === currentIdx ? "now" : ""} ${currentIdx >= 0 && i < currentIdx ? "past" : ""}`}
          >
            <span className="t">{s.time}</span>
            <span className="i">{s.item}</span>
            {i === currentIdx && <span className="now-tag">NOW</span>}
          </div>
        ))}
      </div>
      {d?.focus && <div className="focus-line">focus · {d.focus}</div>}
    </section>
  );
}
