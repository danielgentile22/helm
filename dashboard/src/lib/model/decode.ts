// The one place `unknown` becomes `Model`. A row that fails its contract is skipped and
// counted in `dropped`, never thrown on, because one bad todo row must not blank the
// dashboard. The contracts mirrored here are the docstrings at
// runner/producers/sources/{todos,routines,repos,trackers}.py.

import { DEPARTMENTS, parseIso, thingId, todoId } from "./types";
import type { Department, DoneWhen, Model, Repo, Source, SourceName, Star, StarredDirective, Sub, Thing, TodoKind } from "./types";

const SOURCE_NAMES: readonly SourceName[] = ["todos", "routines", "repos", "trackers"];

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// A department outside the four is a contract violation like any other, so the row is
// dropped and counted rather than quietly filed under Projects, where nobody would ever
// notice the producers had drifted.
function deptOf(value: unknown): Department | null {
  const name = str(value);
  return DEPARTMENTS.find((d) => d === name) ?? null;
}

function doneWhenOf(value: unknown): DoneWhen | null {
  if (!isObj(value)) return null;
  const predicate = str(value["predicate"]);
  if (predicate === null) return null;
  return {
    predicate,
    ok: typeof value["ok"] === "boolean" ? value["ok"] : null,
    checked: parseIso(value["checked"]),
    detail: str(value["detail"]) ?? "",
  };
}

function jobRow(row: Record<string, unknown>): Thing | null {
  const id = str(row["id"]);
  const title = str(row["title"]);
  const at = parseIso(row["at"]);
  const dept = deptOf(row["dept"]);
  if (!id || title === null || at === null || dept === null) return null;
  return {
    kind: "job",
    id: thingId(id),
    dept,
    label: title,
    at,
    schedule: str(row["schedule"]) ?? "",
    path: str(row["path"]) ?? "",
  };
}

// Absent on an unstarred directive. Anything but 1, 2 or 3 is read as unstarred rather than
// dropping the row: a bad star must not hide a todo.
function starOf(value: unknown): Star | null {
  return value === 1 || value === 2 || value === 3 ? value : null;
}

function subsOf(value: unknown): Sub[] {
  const out: Sub[] = [];
  for (const item of arr(value)) {
    if (!isObj(item)) continue;
    const text = str(item["text"]);
    if (text === null) continue;
    out.push({ text, done: item["done"] === true });
  }
  return out;
}

function todoRow(kind: TodoKind, row: Record<string, unknown>): Thing | null {
  const content = str(row["id"]);
  const text = str(row["text"]);
  const since = parseIso(row["since"]);
  const line = num(row["line"]);
  const dept = deptOf(row["dept"]);
  if (!content || text === null || since === null || line === null || dept === null) return null;
  const star = starOf(row["star"]);
  return {
    kind,
    id: thingId(`todo:${content}`),
    todoId: todoId(content),
    dept,
    project: str(row["project"]),
    label: text,
    at: parseIso(row["at"]),
    due: str(row["due"]),
    since,
    doneToday: row["done_today"] === true,
    notes: str(row["notes"]) ?? "",
    subs: subsOf(row["subs"]),
    path: str(row["path"]) ?? "",
    line,
    doneWhen: doneWhenOf(row["done_when"]),
    ...(star === null ? {} : { star }),
  };
}

// agenda.json's `directives`. An older capture has none, and anything that is not an array
// reads as none; an entry without a department, a name and a rank of 1 to 3 is skipped. A
// directive is context, not a row, so a bad one is never counted as a dropped row.
function directivesOf(value: unknown): StarredDirective[] {
  const out: StarredDirective[] = [];
  for (const item of arr(value)) {
    if (!isObj(item)) continue;
    const dept = deptOf(item["dept"]);
    const name = str(item["name"]);
    const star = starOf(item["star"]);
    if (dept === null || !name || star === null) continue;
    out.push({ dept, name, star });
  }
  return out;
}

function trackerOf(value: unknown): Repo["tracker"] {
  if (!isObj(value)) return null;
  const kind = str(value["kind"]);
  const openIssues = num(value["open_issues"]);
  const openPrs = num(value["open_prs"]);
  if (kind === null || openIssues === null || openPrs === null) return null;
  return { kind, openIssues, openPrs, ref: str(value["ref"]) ?? "" };
}

function sessionOf(value: unknown): Repo["lastSession"] {
  if (!isObj(value)) return null;
  const at = parseIso(value["at"]);
  if (at === null) return null;
  return { at, note: str(value["note"]) ?? "" };
}

function repoRow(row: Record<string, unknown>): Repo | null {
  const kind = row["kind"] === "workspace" ? "workspace" : row["kind"] === "repo" ? "repo" : null;
  const name = str(row["name"]);
  if (kind === null || !name) return null;
  // A workspace carries no git fields at all, so every one of them reads null.
  return {
    kind,
    name,
    path: str(row["path"]) ?? "",
    touched: parseIso(row["touched"]),
    branch: str(row["branch"]),
    unmerged: num(row["unmerged_commits"]),
    unpushed: num(row["unpushed_commits"]),
    dirty: num(row["dirty"]),
    tracker: trackerOf(row["tracker"]),
    lastSession: sessionOf(row["last_session"]),
  };
}

function sourcesOf(doc: Record<string, unknown> | null, file: Source["file"]): { sources: Source[]; dropped: number } {
  const bag = doc === null ? null : doc["sources"];
  if (!isObj(bag)) return { sources: [], dropped: 0 };
  const sources: Source[] = [];
  let dropped = 0;
  for (const [key, meta] of Object.entries(bag)) {
    const name = SOURCE_NAMES.find((n) => n === key);
    if (name === undefined || !isObj(meta)) {
      dropped += 1;
      continue;
    }
    sources.push({
      name,
      file,
      produced: parseIso(meta["produced"]),
      attempted: parseIso(meta["attempted"]),
      ok: meta["ok"] === true,
      reason: str(meta["reason"]),
      count: num(meta["count"]) ?? 0,
      cadenceMs: (num(meta["cadence_s"]) ?? 0) * 1000,
    });
  }
  return { sources, dropped };
}

export function decode(agenda: unknown, projects: unknown): Model {
  const a = isObj(agenda) ? agenda : null;
  const p = isObj(projects) ? projects : null;
  let dropped = 0;

  const rows = arr(a === null ? null : a["items"]);

  const things: Thing[] = [];
  for (const row of rows) {
    if (!isObj(row)) {
      dropped += 1;
      continue;
    }
    const kind = row["kind"];
    const thing =
      kind === "job" ? jobRow(row)
      : kind === "todo" || kind === "daily" || kind === "event" ? todoRow(kind, row)
      : null;
    if (thing === null) dropped += 1;
    else things.push(thing);
  }

  const repos: Repo[] = [];
  for (const row of arr(p === null ? null : p["in_flight"])) {
    const repo = isObj(row) ? repoRow(row) : null;
    if (repo === null) dropped += 1;
    else repos.push(repo);
  }

  const fromAgenda = sourcesOf(a, "agenda");
  const fromProjects = sourcesOf(p, "projects");
  dropped += fromAgenda.dropped + fromProjects.dropped;

  return {
    tz: str(a === null ? null : a["tz"]) || "UTC",
    produced: {
      agenda: parseIso(a === null ? null : a["produced"]),
      projects: parseIso(p === null ? null : p["produced"]),
    },
    things,
    directives: directivesOf(a === null ? null : a["directives"]),
    repos,
    sources: [...fromAgenda.sources, ...fromProjects.sources],
    dropped,
  };
}
