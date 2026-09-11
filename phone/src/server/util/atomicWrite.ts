/**
 * Salvaged from helm/lib/atomicWrite.ts. Write-to-temp-then-rename in the
 * same directory so the rename is a single-filesystem atomic replace.
 * Used for thread.json, push/subscriptions.json, auth/credentials.json.
 */
export function atomicWrite(file: string, data: string): Promise<void> {
  // TODO: tmp = `${file}.tmp-${process.pid}-${Date.now()}`; writeFile; rename
  throw new Error("not implemented");
}
