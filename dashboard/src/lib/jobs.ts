import type { Routine, Service } from "./api";

/** How launchd holds the job: its label, the process while one runs, and the last exit. */
export function launchdLine(job: Routine | Service): string {
  const parts = [job.loaded ? job.label : `${job.label}, not loaded`];
  if (job.pid !== null) parts.push(`process ${job.pid}`);
  if (job.last_exit !== null) parts.push(`last exit ${job.last_exit}`);
  return parts.join(" · ");
}

export interface ProjectGroup {
  project: string;
  routines: Routine[];
  services: Service[];
}

/** Routines and services under the project that owns them, in the order models.json first
 * names each project. Jobs models.json does not claim go last. */
export function byProject(routines: Routine[], services: Service[]): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  const group = (project: string | null): ProjectGroup => {
    const key = project ?? "";
    let found = groups.get(key);
    if (!found) groups.set(key, (found = { project: key, routines: [], services: [] }));
    return found;
  };
  for (const r of routines) group(r.project).routines.push(r);
  for (const s of services) group(s.project).services.push(s);
  return [...groups.values()].sort((a, b) => Number(a.project === "") - Number(b.project === ""));
}
