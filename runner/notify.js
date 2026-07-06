/**
 * Native macOS notifications for the runner.
 *
 * Split deliberately into a pure decision and a thin side effect:
 *   decideNotification(event, config) → { title, body } | null   (pure)
 *   emitNotification({ title, body })  → shells `osascript`        (effect)
 *   notify(event, config)              → decide + emit             (wiring)
 *
 * Lives in the RUNNER so alerts fire even with no HUD tab open. No external
 * service, no deps. On non-macOS — or any osascript failure — it no-ops
 * quietly: a missed banner must never break a run.
 *
 * Events (see PRD "Notification event" contract):
 *   run-complete  — a run finished and left a deliverable (a report landing)
 *   run-failed    — a run ended with an error
 *   morphy-delta  — the shared Morphy board changed on a sync (added/closed)
 */

import { spawn } from "node:child_process";
import { platform } from "node:os";

export const NOTIFY_EVENT_TYPES = ["run-complete", "run-failed", "morphy-delta", "fleet-stale"];

/**
 * Build the notification config from an env accessor (pass the runner's `env`).
 *   HELM_NOTIFY        — "off" disables everything (default: on).
 *   HELM_NOTIFY_EVENTS — comma list of event types to allow. UNSET → all three
 *                        (the default). Any explicit value is an allow-list:
 *                        unknown names are dropped, and "" (or whitespace) →
 *                        nothing fires — a way to mute every type with
 *                        HELM_NOTIFY still on.
 */
export function loadNotifyConfig(env = (k) => process.env[k]) {
  const enabled = String(env("HELM_NOTIFY") ?? "on").trim().toLowerCase() !== "off";
  const raw = env("HELM_NOTIFY_EVENTS");
  let types;
  if (raw == null) {
    types = new Set(NOTIFY_EVENT_TYPES); // unset → default to all three
  } else {
    // An explicit value is an allow-list. "" splits/filters down to the empty
    // set, so an explicit blank fires nothing (distinct from unset).
    types = new Set(
      String(raw)
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => NOTIFY_EVENT_TYPES.includes(s))
    );
  }
  return { enabled, types };
}

function isEnabled(config, type) {
  if (!config || config.enabled === false) return false;
  const types = config.types;
  if (types instanceof Set) return types.has(type);
  if (Array.isArray(types)) return types.includes(type);
  return true; // no per-type filter present → every type fires
}

function clip(s, max = 180) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

// Render a few task names ("Foo, Bar, Baz +2 more"); accepts strings or
// {name} objects so it works on both halves of a Morphy delta.
function nameList(items, max = 3) {
  const names = (items || [])
    .map((it) => (typeof it === "string" ? it : it && it.name))
    .filter(Boolean);
  const shown = names.slice(0, max).join(", ");
  const extra = names.length - max;
  return extra > 0 ? `${shown} +${extra} more` : shown;
}

/**
 * Pure: event + config → { title, body } | null. null means "say nothing" —
 * notifications disabled, this type filtered out, or the event carries nothing
 * worth surfacing (a run with no deliverable, a delta with no real change).
 */
export function decideNotification(event, config) {
  if (!event || typeof event.type !== "string") return null;
  if (!isEnabled(config, event.type)) return null;

  switch (event.type) {
    case "run-complete": {
      // Only a run that actually produced a deliverable is worth a banner.
      if (!event.deliverable) return null;
      const skill = event.skill || "run";
      const file = String(event.deliverable).split("/").pop() || event.deliverable;
      return { title: `HELM · ${skill} ready`, body: clip(event.summary || file) };
    }
    case "run-failed": {
      const skill = event.skill || "run";
      return {
        title: `HELM · ${skill} failed`,
        body: clip(event.summary || "The run ended with an error."),
      };
    }
    case "morphy-delta": {
      const added = (event.added || []).length;
      const closed = (event.closed || []).length;
      if (added + closed === 0) return null; // a no-change sync says nothing
      const parts = [];
      if (added) parts.push(`+${added} added`);
      if (closed) parts.push(`${closed} closed`);
      const detail = added ? nameList(event.added) : nameList(event.closed);
      return {
        title: "Morphy board updated",
        body: clip(`${parts.join(", ")}${detail ? ` — ${detail}` : ""}`),
      };
    }
    case "fleet-stale": {
      // Fired by the watchdog (runner/fleet.js) once per new staleness
      // episode; event.stale = [{ id, reason }].
      const stale = event.stale || [];
      if (!stale.length) return null;
      return {
        title: `HELM · ${stale.length} producer${stale.length === 1 ? "" : "s"} stale`,
        body: clip(stale.length === 1 ? stale[0].reason || stale[0].id : nameList(stale.map((s) => s.id), 4)),
      };
    }
    default:
      return null;
  }
}

// AppleScript string literal — escape backslash and double-quote only.
function osaString(s) {
  return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Thin emitter — posts a native banner via `osascript`. macOS only; elsewhere
 * or on any spawn failure it no-ops and returns false. Fire-and-forget: the
 * child is unref'd so it never holds the runner open, and a failure never
 * breaks the run — but it DOES leave one line via the optional logger, so a
 * persistently broken osascript (missing binary, revoked notification
 * permission) is traceable in runner.log instead of silently eating alerts.
 */
export function emitNotification(note, log) {
  if (!note || !note.title) return false;
  if (platform() !== "darwin") return false;
  const script =
    `display notification ${osaString(note.body || "")} ` +
    `with title ${osaString(note.title)}`;
  try {
    const proc = spawn("osascript", ["-e", script], { stdio: "ignore" });
    proc.on("error", (err) => log?.(`notify: osascript failed: ${err.message}`));
    proc.on("close", (code) => {
      if (code !== 0) log?.(`notify: osascript exited ${code} — banner dropped`);
    });
    proc.unref?.();
    return true;
  } catch (e) {
    log?.(`notify: spawn failed: ${e.message}`);
    return false;
  }
}

/** Decide, then emit if there's anything to say. Returns the note, or null. */
export function notify(event, config, log) {
  const note = decideNotification(event, config);
  if (note) emitNotification(note, log);
  return note;
}
