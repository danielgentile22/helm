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

export type KillMode = "group" | "pidTree";

/** SIGTERM now, SIGKILL after graceMs. Never throws; a dead target is a no-op. Resolves once. */
export function killTree(pid: number, mode: KillMode, graceMs?: number): Promise<void> {
  throw new Error("not implemented");
}

/** `pgrep -P` walk. Exposed for the fallback and for tests. */
export function descendantPids(pid: number): Promise<readonly number[]> {
  throw new Error("not implemented");
}
