"use client";

import { useShell } from "@/components/shell/ShellContext";
import { SectionTitle } from "./util";

// Desktop voice + run activity feed — transcript lines and run events, newest
// last. A button opens the full voice transcript overlay.
export default function Feed() {
  const { feed, openTranscript } = useShell();
  return (
    <section className="panel">
      <SectionTitle title="Activity" tick="VOICE · RUNS" />
      <div className="feed">
        {feed.length === 0 ? (
          <div className="feed-empty">no activity yet — hold Space to talk</div>
        ) : (
          feed.slice(-12).map((l, i) => (
            <div className={`feed-line ${l.cls}`} key={`${l.ts}-${i}`}>
              <span className="feed-ts">{l.ts}</span>
              <span>{l.text}</span>
            </div>
          ))
        )}
      </div>
      <button className="btn btn-secondary" onClick={() => void openTranscript()}>
        Transcript
      </button>
    </section>
  );
}
