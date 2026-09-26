/**
 * Salvaged from helm/app/api/chat/route.ts. Kill a child and its
 * grandchildren (MCP servers, shells) so nothing keeps mutating the machine
 * after an interrupt or shutdown.
 *
 * Preferred: the child was spawned `detached`, so it leads a process group
 * and `process.kill(-pid, sig)` reaches everything. Fallback when the SDK
 * spawns the child itself and we cannot set detached: walk `pgrep -P`
 * recursively and signal each pid (best effort, may miss a fast forker).
 */

import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

export type KillMode = "group" | "pidTree";

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    // ESRCH or EPERM: nothing to do.
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** SIGTERM now, SIGKILL after graceMs. Never throws; a dead target is a no-op. Resolves once. */
export async function killTree(pid: number, mode: KillMode, graceMs = 10_000): Promise<void> {
  const targets = mode === "group" ? [-pid] : [pid, ...(await descendantPids(pid))];
  for (const t of targets) signal(t, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return;
    await sleep(50);
  }
  const survivors = mode === "group" ? [-pid] : [pid, ...(await descendantPids(pid))];
  for (const t of survivors) signal(t, "SIGKILL");
}

/** `pgrep -P` walk. Exposed for the fallback and for tests. */
export async function descendantPids(pid: number): Promise<readonly number[]> {
  const children = await new Promise<number[]>((resolve) => {
    execFile("pgrep", ["-P", String(pid)], (err, stdout) => {
      if (err) return resolve([]);
      resolve(stdout.split("\n").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0));
    });
  });
  const out: number[] = [];
  for (const c of children) out.push(c, ...(await descendantPids(c)));
  return out;
}
