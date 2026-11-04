// The tabs' JSON, as dashboard/README.md "The tabs' JSON" names it. Times are ISO 8601 strings.

export type Tracker = "github" | "scratch" | "none";
export type Checks = "pass" | "fail" | "pending" | "none";
export type Scope = "all" | "mine";

export interface Repo {
  name: string;
  path: string;
  github: string | null;
}

export interface IssueCounts {
  open: number;
  by_status: Record<string, number>;
}

export interface PullRequest {
  repo: string;
  number: number;
  title: string;
  url: string;
  draft: boolean;
  ci: Checks;
  author: string;
  branch: string;
}

export interface Branch {
  repo: string;
  name: string;
  ahead: number;
  at: string;
}

export interface Commit {
  at: string;
  repo: string;
  subject: string;
}

export interface Project {
  slug: string;
  title: string;
  note: string | null;
  status: string | null;
  pinned: boolean;
  tracker: Tracker;
  pull_requests_scope: Scope;
  repos: Repo[];
  issues: IssueCounts | null;
  pull_requests: PullRequest[];
  branches: Branch[];
  last_commit: Commit | null;
  ideas_open: number;
  problems: string[];
}

export interface ProjectsResponse {
  produced: string;
  error: string | null;
  projects: Project[];
}

export interface Issue {
  id: string;
  title: string;
  status: string;
  url: string | null;
  path: string | null;
  repo: string | null;
  updated: string | null;
}

export type IdeaStatus = "open" | "done" | "dropped" | "promoted";
export type Department = "Work" | "Projects" | "Chess" | "Life";

export interface Idea {
  id: string;
  path: string;
  title: string;
  created: string;
  status: IdeaStatus;
  department: Department;
  project: string | null;
  due: string | null;
  // A URL for a GitHub tracker, a file path for a local one.
  issue: string | null;
}

/** What the capture box sends. The server derives the department from the project. */
export interface IdeaDraft {
  title: string;
  project: string | null;
  due: string | null;
}

/** The answer to every idea write. `changed` is false when the value was already set. */
export interface IdeaWrite {
  idea: Idea;
  changed: boolean;
}

/** What a promote sends: the repo when the project has several GitHub repos, and the
 *  owner's yes for a repo someone else owns. */
export interface PromoteBody {
  repo?: string;
  confirm?: boolean;
}

/** `issue` is a GitHub URL, or a scratch file's path in tilde form. */
export interface PromoteWrite extends IdeaWrite {
  issue: string;
}

export interface ProjectDetail extends Project {
  produced: string;
  error: string | null;
  issues_list: Issue[];
  ideas: Idea[];
}

export interface IdeasResponse {
  ideas: Idea[];
  errors: string[];
}

export type RoutineResult = "pass" | "fail" | "paused" | "unknown";

export interface Routine {
  name: string;
  kind: "routine";
  schedule: string;
  model: string | null;
  effort: string | null;
  why: string | null;
  label: string;
  loaded: boolean;
  running: boolean;
  last_exit: number | null;
  paused: boolean;
  last_run: string | null;
  result: RoutineResult;
  result_text: string | null;
  failures: number | null;
  last_success: string | null;
  next_run: string | null;
  log_tail: string[];
  log_updated: string | null;
}

export interface Service {
  name: string;
  kind: "service";
  why: string | null;
  listed: boolean;
  label: string;
  loaded: boolean;
  running: boolean;
  last_exit: number | null;
  log_tail: string[];
  log_updated: string | null;
}

export type RoutineAction = "run" | "pause" | "resume";

export interface RoutineWrite {
  routine: Routine;
  changed: boolean;
}

export interface BackgroundResponse {
  routines: Routine[];
  services: Service[];
}

export type DeviceKind =
  | "desktop" | "laptop" | "phone" | "tablet" | "watch" | "display"
  | "dock" | "storage" | "network" | "audio" | "camera" | "home";
export type DeviceStatus = "ordered" | "in service" | "spare" | "retired" | "sold";
export type T3 = "host" | "client" | "none";

export interface Presence {
  online: boolean;
  last_seen: string | null;
}

export interface Device {
  slug: string;
  title: string;
  // The server keeps a value outside these sets as written and names it in `problems`.
  kind: DeviceKind;
  status: DeviceStatus;
  role: string | null;
  t3: T3;
  tailnet: string | null;
  specs: Record<string, string> | null;
  purchased: string | null;
  warranty_until: string | null;
  path: string;
  presence: Presence | null;
  problems: string[];
}

export interface DevicesResponse {
  devices: Device[];
  tailnet_error: string | null;
}

export type Load<T> =
  | { state: "loading" }
  | { state: "ready"; data: T; at: number }
  | { state: "error"; kind: "unauthorized" | "network" | "http"; detail: string; status?: number; body?: unknown };

/** What a fetch settles to: everything but loading. */
export type Answer<T> = Exclude<Load<T>, { state: "loading" }>;
export type Failure = Extract<Load<never>, { state: "error" }>;

async function errorOf(res: Response): Promise<{ detail: string; body?: unknown }> {
  try {
    const body: unknown = await res.json();
    const error = (body as { error?: { detail?: unknown } }).error;
    if (typeof error?.detail === "string") return { detail: error.detail, body };
  } catch {
    // Not JSON; fall through to the status line.
  }
  return { detail: `helm answered ${res.status} ${res.statusText}`.trim() };
}

/** A GET, or a POST of `body` as JSON. Never throws. */
export async function fetchJson<T>(path: string, body?: unknown): Promise<Answer<T>> {
  const init: RequestInit = { credentials: "same-origin", headers: { accept: "application/json" } };
  if (body !== undefined) {
    init.method = "POST";
    init.headers = { accept: "application/json", "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return { state: "error", kind: "network", detail: `Could not reach helm (${why}). Check the connection and try again.` };
  }
  if (res.status === 401) return { state: "error", kind: "unauthorized", detail: (await errorOf(res)).detail };
  if (!res.ok) return { state: "error", kind: "http", status: res.status, ...(await errorOf(res)) };
  try {
    return { state: "ready", data: (await res.json()) as T, at: Date.now() };
  } catch {
    return { state: "error", kind: "http", detail: `helm answered ${path} with something that is not JSON` };
  }
}
