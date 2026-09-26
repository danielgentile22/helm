// Obsidian deep links. The pure builder lives here (no DOM, no env) so a plain
// tsx test can import it; the public vault-name setting rides alongside it as the
// one source of truth the HUD and the report overlay share.

/**
 * Build an `obsidian://open` deep link for a vault-relative note path.
 *
 * The vault name and path are URL-encoded (so `/` becomes `%2F`, matching
 * Obsidian's own URI scheme), and the trailing file extension is dropped —
 * Obsidian resolves a note by its extensionless vault path.
 *
 *   obsidianUri("Vault", "inbox/reports/morning/2026-06-16-x.md")
 *     → "obsidian://open?vault=Vault&file=inbox%2Freports%2Fmorning%2F2026-06-16-x"
 */
export function obsidianUri(vaultName: string, relPath: string): string {
  const file = relPath.replace(/\.[^/.]+$/, ""); // drop the trailing extension
  return `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(file)}`;
}

/** Obsidian vault name (the vault folder's basename) — the obsidian:// URI needs
 *  the exact name. Client-side, so NEXT_PUBLIC_ (inlined at build). Unset = every
 *  "open in Obsidian" affordance hides itself. */
export const OBSIDIAN_VAULT = process.env.NEXT_PUBLIC_OBSIDIAN_VAULT ?? "";
