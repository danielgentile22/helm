/**
 * Exactly one Helm process may write the logs. This is not a nicety: seq
 * allocation is an in-memory counter and the offset index assumes a single
 * appender, so a second process would silently corrupt both.
 *
 * Helm REFUSES TO BOOT rather than degrade. A launchd KeepAlive job that
 * double-starts is exactly the scenario this exists for.
 */

export interface InstanceLock {
  readonly pid: number;
  release(): Promise<void>;
}

/**
 * Acquire HELM_HOME/helm.lock.
 *
 * Stale-lock handling: a lockfile whose recorded pid is not alive (kill(pid, 0)
 * throws ESRCH) is from a crashed process and is reclaimed. A lockfile whose pid IS
 * alive throws. We check pid liveness rather than mtime because a wedged-but-alive
 * server is precisely the case where taking the lock would be catastrophic.
 *
 * Idempotent within a process: calling twice returns the same lock.
 */
export async function acquireInstanceLock(helmHome: string): Promise<InstanceLock> {
  throw new Error("not implemented");
  // TODO:
  //   try { fd = await open(path, "wx") }            // O_CREAT|O_EXCL
  //   catch EEXIST {
  //     pid = Number(await readFile(path))
  //     if (isAlive(pid)) throw new Error(`helm already running as pid ${pid}`)
  //     await unlink(path); retry once
  //   }
  //   await fd.writeFile(String(process.pid))
  //   register release() on SIGINT/SIGTERM/beforeExit
}
