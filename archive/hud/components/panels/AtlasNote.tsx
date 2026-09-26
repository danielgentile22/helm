"use client";

import { useEffect, useState } from "react";
import { mdToHtml } from "@/lib/reportMd";
import { SectionTitle } from "@/components/panels/util";

// Curated-Atlas-note panel for the project tabs (issue #43) — Jobs shows
// "Career - Applications & Roles", Chess shows "Chess - Tournament Log".
// Read-only render via /api/report (same overlay pipeline: readVaultMarkdown
// allowlist + the XSS-tested mdToHtml). Fetched once per mount — Atlas notes
// change on Daniel's cadence, not the HUD's 5s poll.
export default function AtlasNote({ path, title }: { path: string; title: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch(`/api/report?path=${encodeURIComponent(path)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then((j: { content: string }) => {
        if (alive) setHtml(mdToHtml(j.content));
      })
      .catch(() => {
        if (alive) setMissing(true);
      });
    return () => {
      alive = false;
    };
  }, [path]);

  return (
    <section className="panel">
      <SectionTitle title={title} tick="ATLAS" />
      {missing ? (
        <div className="tab-sub">No note at {path} yet.</div>
      ) : html === null ? (
        <div className="tab-sub">loading…</div>
      ) : (
        <div className="report-body atlas-note" dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </section>
  );
}
