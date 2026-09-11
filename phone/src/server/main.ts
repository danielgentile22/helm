/**
 * Boot order (each step idempotent, so a crash loop under launchd KeepAlive
 * converges):
 *
 *   1. load .env (HELM_API_KEY, HELM_VAPID_*, HELM_BIND_ADDR, HELM_VAULT_ROOT, HELM_HOME=~/.helm2)
 *   2. logs.recoverAll(): torn-tail truncation, orphaned turns closed, queued inputs dropped (log I3/I4)
 *   3. mirror.resume() per thread: catch the vault markdown up to the log
 *   4. push.watch + mirror.watch on every open log (and on every future open via LogRegistry hook)
 *   5. listen on the tailnet address only (never 0.0.0.0); `tailscale serve` provides HTTPS
 *   6. on SIGTERM: supervisor.shutdown() (kill groups, 10 s grace), then exit
 *
 * Nothing here spawns Claude. The first send() does.
 */

export interface Env {
  readonly HELM_HOME: string; // ~/.helm2
  readonly HELM_VAULT_ROOT: string; // ~/Projects/Vault
  readonly HELM_BIND_ADDR: string; // tailnet IPv4 of this host
  readonly HELM_PORT: number;
  readonly HELM_API_KEY: string | undefined;
  readonly HELM_VAPID_PUBLIC: string;
  readonly HELM_VAPID_PRIVATE: string;
  readonly HELM_VAPID_SUBJECT: string;
  readonly HELM_ADD_DIRS: readonly string[]; // default ~/Projects ~/Desktop ~/Documents
}

/** Parse process.env at the boundary; throws with a readable message on a missing required key. */
export function loadEnv(raw: NodeJS.ProcessEnv): Env {
  throw new Error("not implemented");
}

export async function main(): Promise<void> {
  throw new Error("not implemented");
}
