// Obsidian deep-link sweep — obsidianUri(vaultName, relPath) builds an
// obsidian://open URI: vault name + vault-relative path, trailing extension
// dropped, both URL-encoded. Pure, no DOM, no I/O.
// Run: npx -y tsx scripts/test-obsidian.ts
import { obsidianUri } from "../lib/obsidian";

let failed = 0;
const pass = (msg: string) => console.log(`PASS  ${msg}`);
const fail = (msg: string) => {
  failed++;
  console.log(`FAIL  ${msg}`);
};
const eq = (got: string, want: string, msg: string) =>
  got === want ? pass(msg) : fail(`${msg}\n        got  ${got}\n        want ${want}`);

// --- the spec's canonical example -------------------------------------------
eq(
  obsidianUri("Vault", "inbox/reports/morning/2026-06-16-x.md"),
  "obsidian://open?vault=Vault&file=inbox%2Freports%2Fmorning%2F2026-06-16-x",
  "canonical example: slashes encoded, .md dropped"
);

// --- extension drop ----------------------------------------------------------
eq(obsidianUri("V", "note.md"), "obsidian://open?vault=V&file=note", "drops a trailing .md");
eq(
  obsidianUri("V", "a/b/c.md"),
  "obsidian://open?vault=V&file=a%2Fb%2Fc",
  "drops the extension, keeps the path"
);
eq(
  obsidianUri("V", "no-extension"),
  "obsidian://open?vault=V&file=no-extension",
  "no extension → path unchanged"
);
eq(
  obsidianUri("V", "report.v2.md"),
  "obsidian://open?vault=V&file=report.v2",
  "only the FINAL extension is dropped (interior dots kept)"
);
eq(
  obsidianUri("V", "2026.06.16/daily.md"),
  "obsidian://open?vault=V&file=2026.06.16%2Fdaily",
  "dots in a folder segment are preserved"
);

// --- encoding of vault name + path ------------------------------------------
eq(
  obsidianUri("My Vault", "x.md"),
  "obsidian://open?vault=My%20Vault&file=x",
  "spaces in the vault name are percent-encoded"
);
eq(
  obsidianUri("V", "inbox/voice asks/q.md"),
  "obsidian://open?vault=V&file=inbox%2Fvoice%20asks%2Fq",
  "spaces and slashes in the path are percent-encoded"
);
eq(
  obsidianUri("Daniel & Co", "a&b.md"),
  "obsidian://open?vault=Daniel%20%26%20Co&file=a%26b",
  "ampersands are encoded so they can't break the query string"
);

// --- shape -------------------------------------------------------------------
const check = (cond: unknown, msg: string) => (cond ? pass(msg) : fail(msg));
const uri = obsidianUri("Vault", "inbox/x.md");
check(uri.startsWith("obsidian://open?vault="), "starts with the obsidian://open scheme");
check(/^obsidian:\/\/open\?vault=([^&]*)&file=(.*)$/.test(uri), "exactly two query params: vault then file");

console.log(failed === 0 ? `\nAll obsidian checks pass.` : `\n${failed} obsidian check(s) failed.`);
process.exit(failed ? 1 : 0);
