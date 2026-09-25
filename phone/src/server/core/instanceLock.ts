/**
 * Exactly one Helm process may write the logs. This is not a nicety: seq
 * allocation is an in-memory counter, so a second process would silently
 * corrupt every log.
 *
 * Helm REFUSES TO BOOT rather than degrade. A launchd KeepAlive job that
 * double-starts is exactly the scenario this exists for.
 */

import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

export interface InstanceLock {
  readonly pid: number;
  release(): Promise<void>;
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

let held: InstanceLock | null = null;

/**
 * Acquire HELM_HOME/helm.lock.
 *
 * Stale-lock handling: a lockfile whose recorded pid is not alive is from a
 * crashed process and is reclaimed. A lockfile whose pid IS alive throws. We
 * check pid liveness rather than mtime because a wedged-but-alive server is
 * precisely the case where taking the lock would be catastrophic.
 *
 * Idempotent within a process: calling twice returns the same lock.
 */
export async function acquireInstanceLock(helmHome: string): Promise<InstanceLock> {
  if (held) return held;
  await mkdir(helmHome, { recursive: true });
  const path = join(helmHome, "helm.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fh = await open(path, "wx");
      await fh.writeFile(String(process.pid));
      await fh.close();
      const lock: InstanceLock = {
        pid: process.pid,
        release: async () => {
          held = null;
          await unlink(path).catch(() => undefined);
        },
      };
      held = lock;
      return lock;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const pid = Number((await readFile(path, "utf8").catch(() => "")).trim());
      if (isAlive(pid) && pid !== process.pid) throw new Error(`helm already running as pid ${pid} (lock: ${path})`);
      await unlink(path).catch(() => undefined);
    }
  }
  throw new Error(`could not acquire ${path}`);
}
