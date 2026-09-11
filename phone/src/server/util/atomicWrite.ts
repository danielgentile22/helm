/**
 * Salvaged from helm/lib/atomicWrite.ts. Write-to-temp-then-rename in the
 * same directory so the rename is a single-filesystem atomic replace.
 * Used for thread.json, push/subscriptions.json, auth/credentials.json.
 */

import { rename, writeFile } from "node:fs/promises";

export async function atomicWrite(file: string, data: string): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}
