"use client";

// Morphy — the consulting board. All Morphy state in one place: the objective
// (open TODOs), the need-me detail (what Michael moved since the last sync +
// what's open for me), the GitHub repo activity as stat tiles, and the board
// glance. Actions: Morphy Sync (desktop) + Task Add. Reads the runner's cache
// (state.morphy) — the HUD never calls Notion.
import { useShell } from "@/components/shell/ShellContext";
import { deckSkillsForTab } from "@/lib/tabs";
import { statTileProps } from "@/lib/vitals";
import type { Metric } from "@/lib/vault";
import StatTile from "@/components/StatTile";
import Deck from "@/components/panels/Deck";
import TaskAdd from "@/components/panels/TaskAdd";
import { fmtAge, fmtAgo, SectionTitle } from "@/components/panels/util";

function findMetric(metrics: Metric[], source: string, metric: string): Metric | null {
  return metrics.find((m) => m.source === source && m.metric === metric) ?? null;
}

const OPEN = ["todo", "in progress", "blocked"];

export default function MorphyPage() {
  const { state, status, isPhone } = useShell();
  const mp = state?.morphy ?? null;
  const synced = !!mp && mp.ok !== false;

  const gh = (m: string) => (state ? findMetric(state.metrics, "github", m) : null);
  const commits = gh("commits_7d");
  const prs = gh("open_prs");
  const issues = gh("open_issues");

  // objective figures
  const open = mp?.open_total ?? 0;
  const ideas = mp?.ideas_awaiting ?? 0;
  const total = mp?.total ?? 0;
  const done = mp?.counts?.done ?? 0;
  const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0;
  const tasks = mp?.tasks ?? [];
  const openTasksFor = (who: string) =>
    tasks.filter((t) => OPEN.includes((t.status || "").toLowerCase()) && t.assignee === who);
  const danielOpen = openTasksFor("Daniel");

  // board glance
  const ba = mp?.open_by_assignee ?? {};
  const rows = (["Daniel", "Michael", "Both", "Unassigned"] as const).filter(
    (k) => k === "Daniel" || k === "Michael" || (ba[k] ?? 0) > 0
  );
  const added = mp?.delta?.added ?? [];
  const closed = mp?.delta?.closed ?? [];

  return (
    <div className="tab-page">
      <div className="tab-head">
        <h1 className="tab-title">Morphy</h1>
        <p className="tab-sub">
          {synced ? `board synced ${fmtAgo(mp!.last_sync_ts)}` : "board not synced yet"}
        </p>
      </div>

      {!synced && (
        <section className="panel">
          <div className="morphy-offline">
            board not syncing{mp?.reason ? ` — ${mp.reason}` : ""} — run Morphy Sync to pull the latest
          </div>
        </section>
      )}

      {/* objective + need-me */}
      <div className="tab-grid grid-2">
        <section className="objective">
          <div className="obj-label">Morphy Board · Open TODOs</div>
          <div className="big">
            {synced ? open : "—"}
            <span className="unit">OPEN</span>
          </div>
          <div className="progress">
            <i style={{ width: `${pct}%` }} />
          </div>
          <div className="sub">
            <span>
              ideas <b>{ideas}</b>
            </span>
            <span>
              daniel <b>{danielOpen.length}</b>
            </span>
            <span>
              michael <b>{openTasksFor("Michael").length}</b>
            </span>
          </div>
        </section>

        <section className="panel">
          <SectionTitle title="Need Me" tick={`${status.needMeCount} FLAGGED`} />
          <div className="needme">
            <div className="needme-line">
              <span className="needme-k">since last sync</span>
              <span className="needme-v">
                {added.length > 0 && <span className="morphy-up">+{added.length} added</span>}
                {closed.length > 0 && <span className="morphy-down">−{closed.length} closed</span>}
                {added.length === 0 && closed.length === 0 && <span className="dim">no change</span>}
              </span>
            </div>
            {added.slice(0, 4).map((a, i) => (
              <div className="needme-item" key={`a-${i}`}>
                <span className="morphy-up">+</span> {a.name.slice(0, 48)}
                {a.addedBy && <span className="dim"> · {a.addedBy}</span>}
              </div>
            ))}
            <div className="needme-line">
              <span className="needme-k">open for you</span>
              <span className="needme-v">
                <b>{status.morphy.openForYou}</b>
              </span>
            </div>
            {danielOpen.slice(0, 4).map((t, i) => (
              <div className="needme-item" key={`d-${i}`}>
                <span className="dim">▸</span> {t.name.slice(0, 48)}
                {t.priority && <span className="dim"> · {t.priority}</span>}
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* GitHub repo activity */}
      <div className="tab-grid grid-3">
        {commits && (
          <StatTile
            label="Commits"
            {...statTileProps(commits, { raw: true, per: "/7d" })}
            unit="/7d"
            foot={process.env.NEXT_PUBLIC_MORPHY_REPO || "repo activity"}
            stale={fmtAge(commits.timestamp).stale}
          />
        )}
        {prs && (
          <StatTile
            label="Open PRs"
            value={prs.value}
            tone="info"
            spark={prs.history.map((h) => h.value)}
            stale={fmtAge(prs.timestamp).stale}
          />
        )}
        {issues && (
          <StatTile
            label="Open Issues"
            value={issues.value}
            tone="warning"
            spark={issues.history.map((h) => h.value)}
            stale={fmtAge(issues.timestamp).stale}
          />
        )}
      </div>

      {/* board glance + actions */}
      <div className="tab-grid grid-2">
        {synced && (
          <section className="panel">
            <SectionTitle title="Board" tick={`${mp!.total ?? 0} CARDS`} />
            <div className="morphy-stats">
              <div className="morphy-stat">
                <span className="morphy-n">{open}</span>
                <span className="morphy-k">open</span>
              </div>
              <div className="morphy-stat">
                <span className="morphy-n">{ideas}</span>
                <span className="morphy-k">ideas</span>
              </div>
              <div className="morphy-stat">
                <span className="morphy-n">{done}</span>
                <span className="morphy-k">done</span>
              </div>
            </div>
            <div className="morphy-rows">
              {rows.map((k) => (
                <div className="morphy-row" key={k}>
                  <span>{k}</span>
                  <span className="morphy-rn">{ba[k] ?? 0}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        <div className="tab-grid" style={{ gap: 16 }}>
          {isPhone === false && <Deck skills={deckSkillsForTab("morphy")} title="Board Actions" />}
          <TaskAdd />
        </div>
      </div>
    </div>
  );
}
